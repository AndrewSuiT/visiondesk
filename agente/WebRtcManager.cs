using System;
using System.Collections.Generic;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using SIPSorcery.Net;

namespace VisionDesk.Agent
{
    /// <summary>
    /// Manages the WebRTC peer connection, STUN/TURN ICE candidate gathering,
    /// RTCDataChannels (video/control), ping RTT calculation, and seamless fallback.
    /// </summary>
    public class WebRtcManager : IDisposable
    {
        private RTCPeerConnection _pc;
        private RTCDataChannel _videoChannel;
        private RTCDataChannel _controlChannel;
        private readonly object _lock = new object();
        private volatile bool _isDisposed;
        private volatile bool _isConnected;
        private volatile bool _sctpOptimized = false;
        private string _sessionId;
        private string _activeCandidateType = "unknown";
        private Action<string> _sendSignalJson;
        private Action<string> _log;

        public Action<byte[]> OnInputPacketReceived;
        public Action OnConnected;
        public Action<string> OnDisconnected;
        public Action OnFallbackRequired;

        private int _connectedFired = 0;

        public bool IsConnected { get { return _isConnected; } }
        public string SessionId { get { return _sessionId; } }
        public string ActiveCandidateType { get { return _activeCandidateType; } }

        public ulong VideoBufferedAmount
        {
            get
            {
                var ch = _videoChannel ?? _controlChannel;
                return (ch != null) ? ch.bufferedAmount : 0;
            }
        }

        public WebRtcManager(Action<string> sendSignalJson, Action<string> log = null)
        {
            _sendSignalJson = sendSignalJson;
            _log = log;
        }

        private void Log(string msg)
        {
            if (_log != null) _log("[WebRTC] " + msg);
        }

        public void Initialize(string sessionId, List<object> iceServersList = null)
        {
            lock (_lock)
            {
                Close();
                _sessionId = sessionId;
                _isDisposed = false;
                _isConnected = false;
                _sctpOptimized = false;
                _activeCandidateType = "unknown";

                _connectedFired = 0;

                var config = new RTCConfiguration
                {
                    iceServers = new List<RTCIceServer>(),
                    X_ICEIncludeAllInterfaceAddresses = true,
                    X_GatherTimeoutMs = 1500
                };

                // Add public Google STUN fallback
                config.iceServers.Add(new RTCIceServer { urls = "stun:stun.l.google.com:19302" });

                // Add custom ICE servers if supplied by signaling server
                if (iceServersList != null && iceServersList.Count > 0)
                {
                    foreach (var item in iceServersList)
                    {
                        var dict = item as Dictionary<string, object>;
                        if (dict == null || !dict.ContainsKey("urls")) continue;

                        string username = dict.ContainsKey("username") ? Convert.ToString(dict["username"]) : null;
                        string credential = dict.ContainsKey("credential") ? Convert.ToString(dict["credential"]) : null;

                        // urls can be a string or a List<object> of strings
                        object urlsObj = dict["urls"];
                        List<string> urlList = new List<string>();

                        if (urlsObj is string)
                        {
                            urlList.Add((string)urlsObj);
                        }
                        else if (urlsObj is List<object>)
                        {
                            foreach (var u in (List<object>)urlsObj)
                            {
                                if (u != null) urlList.Add(Convert.ToString(u));
                            }
                        }

                        foreach (string url in urlList)
                        {
                            if (string.IsNullOrEmpty(url)) continue;
                            var srv = new RTCIceServer { urls = url };
                            if (!string.IsNullOrEmpty(username)) srv.username = username;
                            if (!string.IsNullOrEmpty(credential)) srv.credential = credential;
                            config.iceServers.Add(srv);
                            Log(string.Format("Added ICE server: {0}", url));
                        }
                    }
                }

                _pc = new RTCPeerConnection(config);

                _pc.onicecandidate += (candidate) =>
                {
                    if (candidate != null && !string.IsNullOrEmpty(candidate.candidate))
                    {
                        Log(string.Format("Gathered ICE candidate: [{0}] {1}", candidate.type, candidate.candidate));
                        SendSignalCandidate(candidate);
                    }
                };

                _pc.oniceconnectionstatechange += (state) =>
                {
                    Log(string.Format("ICE Connection State changed: {0}", state));
                    if (state == RTCIceConnectionState.connected)
                    {
                        _isConnected = true;
                        OptimizeSctpStack();
                        UpdateActiveCandidateTelemetry();
                        var ch = _videoChannel ?? _controlChannel;
                        if (ch != null && (ch.IsOpened || ch.readyState == RTCDataChannelState.open))
                        {
                            if (Interlocked.CompareExchange(ref _connectedFired, 1, 0) == 0)
                            {
                                if (OnConnected != null) OnConnected();
                            }
                        }
                    }
                    else if (state == RTCIceConnectionState.failed || state == RTCIceConnectionState.disconnected)
                    {
                        _isConnected = false;
                        if (OnFallbackRequired != null) OnFallbackRequired();
                    }
                };

                _pc.ondatachannel += (dc) =>
                {
                    Log(string.Format("DataChannel incoming from controller: label='{0}'", dc.label));
                    BindDataChannel(dc);
                };
            }
        }

        private void BindDataChannel(RTCDataChannel dc)
        {
            if (dc == null) return;
            string label = dc.label ?? "";

            if (label == "visiondesk-video")
            {
                _videoChannel = dc;
            }
            else if (label == "visiondesk-control" || label == "visiondesk-p2p" || string.IsNullOrEmpty(label))
            {
                _controlChannel = dc;
                if (_videoChannel == null) _videoChannel = dc; // Shared channel fallback
            }

            Action triggerConnected = () =>
            {
                Log(string.Format("DataChannel '{0}' is OPEN (State: {1}).", dc.label, dc.readyState));
                _isConnected = true;
                OptimizeSctpStack();
                UpdateActiveCandidateTelemetry();
                if (Interlocked.CompareExchange(ref _connectedFired, 1, 0) == 0)
                {
                    if (OnConnected != null) OnConnected();
                }
            };

            dc.onopen += () => triggerConnected();

            // SIPSorcery ondatachannel hands dc already in Open state: trigger immediately!
            if (dc.IsOpened || dc.readyState == RTCDataChannelState.open)
            {
                triggerConnected();
            }

            dc.onclose += () =>
            {
                Log(string.Format("DataChannel '{0}' closed.", dc.label));
            };

            dc.onerror += (err) =>
            {
                Log(string.Format("DataChannel '{0}' error: {1}", dc.label, err));
            };

            dc.onmessage += (channel, protocol, data) =>
            {
                if (data == null || data.Length == 0) return;

                byte opcode = data[0];

                // Opcode 0x05: Ping / Pong RTT Telemetry -> Echo back immediately
                if (opcode == 0x05)
                {
                    try
                    {
                        channel.send(data);
                    }
                    catch { }
                    return;
                }

                // Input Injection (Opcode 0x02 Mouse, 0x03 Keyboard, 0x04 Text Macro)
                if (OnInputPacketReceived != null)
                {
                    OnInputPacketReceived(data);
                }
            };
        }

        public async Task HandleRemoteOfferAsync(string sdp)
        {
            if (_pc == null || string.IsNullOrEmpty(sdp)) return;

            Log("Processing remote WebRTC Offer...");
            var descInit = new RTCSessionDescriptionInit
            {
                type = RTCSdpType.offer,
                sdp = sdp
            };

            var res = _pc.setRemoteDescription(descInit);
            if (res != SetDescriptionResultEnum.OK)
            {
                Log(string.Format("Failed to set remote description: {0}", res));
                if (OnFallbackRequired != null) OnFallbackRequired();
                return;
            }

            var answer = _pc.createAnswer(null);
            await _pc.setLocalDescription(answer);

            Log(string.Format("Generated WebRTC Answer SDP (length: {0}). Sending via signaling...", answer.sdp.Length));
            SendSignalAnswer(answer.sdp);
        }

        public void HandleRemoteAnswer(string sdp)
        {
            if (_pc == null || string.IsNullOrEmpty(sdp)) return;
            Log("Processing remote WebRTC Answer...");
            var descInit = new RTCSessionDescriptionInit
            {
                type = RTCSdpType.answer,
                sdp = sdp
            };
            _pc.setRemoteDescription(descInit);
        }

        public void HandleRemoteCandidate(Dictionary<string, object> candDict)
        {
            if (_pc == null || candDict == null) return;
            try
            {
                string candStr = candDict.ContainsKey("candidate") ? Convert.ToString(candDict["candidate"]) : "";
                string sdpMid = candDict.ContainsKey("sdpMid") ? Convert.ToString(candDict["sdpMid"]) : "";
                ushort sdpIndex = candDict.ContainsKey("sdpMLineIndex") ? Convert.ToUInt16(candDict["sdpMLineIndex"]) : (ushort)0;

                if (!string.IsNullOrEmpty(candStr))
                {
                    var init = new RTCIceCandidateInit
                    {
                        candidate = candStr,
                        sdpMid = sdpMid,
                        sdpMLineIndex = sdpIndex
                    };
                    _pc.addIceCandidate(init);
                    Log(string.Format("Applied remote ICE candidate: {0}", candStr));
                }
            }
            catch (Exception ex)
            {
                Log(string.Format("Error adding remote candidate: {0}", ex.Message));
            }
        }

        public bool SendVideoFrame(byte[] data, int offset, int count)
        {
            var channel = _videoChannel ?? _controlChannel;
            if (channel == null || !channel.IsOpened) return false;

            // Safety check: ensure SCTP stack is accelerated
            if (!_sctpOptimized) OptimizeSctpStack();

            // Congestion Control / Anti-Bufferbloat Guard:
            // Drop frame if SCTP send buffer exceeds 64 KB (65536 bytes) so stale frames are not queued.
            if (channel.bufferedAmount > 65536)
            {
                return false;
            }

            try
            {
                // Zero-allocation send using SIPSorcery's (byte[], int, int) overload directly
                channel.send(data, offset, count);
                return true;
            }
            catch
            {
                return false;
            }
        }

        public void OptimizeSctpStack()
        {
            if (_sctpOptimized || _pc == null) return;
            try
            {
                var sctpTransport = _pc.sctp;
                if (sctpTransport == null) return;

                var assoc = sctpTransport.RTCSctpAssociation;
                if (assoc == null) return;

                var senderField = typeof(SctpAssociation).GetField("_dataSender",
                    BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public);
                if (senderField != null)
                {
                    var sender = senderField.GetValue(assoc);
                    if (sender != null)
                    {
                        var senderType = sender.GetType();
                        var burstField = senderType.GetField("_burstPeriodMilliseconds",
                            BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public);
                        if (burstField != null)
                        {
                            // Reduce burst sleep from 50 ms to 1 ms (50x throughput increase)
                            burstField.SetValue(sender, 1);
                        }

                        var cwndField = senderType.GetField("_congestionWindow",
                            BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public);
                        if (cwndField != null)
                        {
                            // Expand initial congestion window from 4.3 KB to 512 KB
                            cwndField.SetValue(sender, (uint)524288);
                        }

                        var ssthreshField = senderType.GetField("_slowStartThreshold",
                            BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public);
                        if (ssthreshField != null)
                        {
                            ssthreshField.SetValue(sender, (uint)524288);
                        }

                        _sctpOptimized = true;
                        Log("SCTP acceleration enabled: burst=1ms, cwnd=512KB, ssthresh=512KB.");
                    }
                }
            }
            catch (Exception ex)
            {
                Log("SCTP acceleration warning: " + ex.Message);
            }
        }

        private void UpdateActiveCandidateTelemetry()
        {
            if (_pc == null) return;
            try
            {
                var iceChannelField = typeof(RTCPeerConnection).GetField("_rtpIceChannel",
                    BindingFlags.Instance | BindingFlags.NonPublic);
                if (iceChannelField != null)
                {
                    var iceChannel = iceChannelField.GetValue(_pc) as RtpIceChannel;
                    if (iceChannel != null && iceChannel.NominatedEntry != null)
                    {
                        var localType = iceChannel.NominatedEntry.LocalCandidate != null
                            ? iceChannel.NominatedEntry.LocalCandidate.type.ToString().ToLowerInvariant()
                            : null;
                        var remoteType = iceChannel.NominatedEntry.RemoteCandidate != null
                            ? iceChannel.NominatedEntry.RemoteCandidate.type.ToString().ToLowerInvariant()
                            : null;

                        if (localType == "relay" || remoteType == "relay")
                        {
                            _activeCandidateType = "relay";
                        }
                        else if (localType == "host" || remoteType == "host")
                        {
                            _activeCandidateType = "host";
                        }
                        else
                        {
                            _activeCandidateType = "srflx";
                        }

                        Log(string.Format("Active ICE candidate pair: {0} <-> {1} ({2})",
                            localType, remoteType, _activeCandidateType));
                    }
                }
            }
            catch (Exception ex)
            {
                Log("Error reading nominated ICE candidate: " + ex.Message);
            }
        }

        public bool SendControlMessage(string text)
        {
            var channel = _controlChannel ?? _videoChannel;
            if (channel == null || string.IsNullOrEmpty(text)) return false;
            try
            {
                channel.send(text);
                return true;
            }
            catch
            {
                return false;
            }
        }

        private void SendSignalAnswer(string sdp)
        {
            if (_sendSignalJson == null) return;
            string escSdp = EscapeJsonString(sdp);
            string json = string.Format(
                "{{\"type\":\"webrtc:signal\",\"payload\":{{\"sessionId\":\"{0}\",\"signalType\":\"answer\",\"data\":{{\"type\":\"answer\",\"sdp\":\"{1}\"}},\"signal\":{{\"type\":\"answer\",\"sdp\":\"{1}\"}}}}}}",
                _sessionId, escSdp);
            _sendSignalJson(json);
        }

        private void SendSignalCandidate(RTCIceCandidate cand)
        {
            if (_sendSignalJson == null || cand == null) return;
            string rawCand = cand.candidate ?? "";
            if (!string.IsNullOrEmpty(rawCand) && !rawCand.StartsWith("candidate:"))
            {
                rawCand = "candidate:" + rawCand;
            }
            string candStr = EscapeJsonString(rawCand);
            string sdpMid = EscapeJsonString(cand.sdpMid ?? "0");
            int mlineIndex = cand.sdpMLineIndex;

            string json = string.Format(
                "{{\"type\":\"webrtc:signal\",\"payload\":{{\"sessionId\":\"{0}\",\"signalType\":\"candidate\",\"data\":{{\"candidate\":\"{1}\",\"sdpMid\":\"{2}\",\"sdpMLineIndex\":{3}}},\"candidate\":{{\"candidate\":\"{1}\",\"sdpMid\":\"{2}\",\"sdpMLineIndex\":{3}}},\"signal\":{{\"type\":\"candidate\",\"candidate\":\"{1}\",\"sdpMid\":\"{2}\",\"sdpMLineIndex\":{3}}}}}}}",
                _sessionId, candStr, sdpMid, mlineIndex);
            _sendSignalJson(json);
        }

        private static string EscapeJsonString(string s)
        {
            if (string.IsNullOrEmpty(s)) return "";
            return s.Replace("\\", "\\\\")
                    .Replace("\"", "\\\"")
                    .Replace("\r", "\\r")
                    .Replace("\n", "\\n")
                    .Replace("\t", "\\t");
        }

        public void Close()
        {
            lock (_lock)
            {
                _isConnected = false;
                _sctpOptimized = false;
                _activeCandidateType = "unknown";
                if (_videoChannel != null)
                {
                    try { _videoChannel.close(); } catch { }
                    _videoChannel = null;
                }
                if (_controlChannel != null)
                {
                    try { _controlChannel.close(); } catch { }
                    _controlChannel = null;
                }
                if (_pc != null)
                {
                    try { _pc.Close("session_ended"); } catch { }
                    try { _pc.Dispose(); } catch { }
                    _pc = null;
                }
            }
        }

        public void Dispose()
        {
            if (!_isDisposed)
            {
                _isDisposed = true;
                Close();
            }
        }
    }
}
