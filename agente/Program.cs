/**
 * VisionDesk - Centralized Remote Monitoring & Administration System
 * File: agent/Program.cs
 *
 * Standalone Windows Background Agent for Arequipa Branches.
 * Compiled natively with C# 5 compiler (csc.exe v4.0.30319) with ZERO external dependencies.
 *
 * Capabilities:
 * - 9-digit persistent machine ID derived from HKLM MachineGuid formatted as triplets.
 * - Resilient ClientWebSocket lifecycle with exponential backoff reconnect loop (2s..30s).
 * - Registration telemetry with branch ID and host metadata.
 * - Heartbeat ping loop every 5s with RTT latency calculation.
 * - GDI BitBlt screen capture and JPEG compression for 5s periodic thumbnails.
 * - Live streaming (15 FPS, Opcode 0x01) and Win32 SendInput input handling.
 * - Server message dispatcher for session:start, session:stop, and peer:auth_request.
 * - Headless silent execution (/target:winexe) with optional terminal attach via AttachConsole.
 */

using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Win32;

namespace VisionDesk.Agent
{
    #region Win32 API Interop
    internal static class NativeMethods
    {
        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool AttachConsole(uint dwProcessId);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool FreeConsole();

        public const uint ATTACH_PARENT_PROCESS = 0xFFFFFFFF;

        public static void InitConsole()
        {
            try
            {
                if (AttachConsole(ATTACH_PARENT_PROCESS))
                {
                    Stream sOut = Console.OpenStandardOutput();
                    if (sOut != null && sOut != Stream.Null)
                    {
                        StreamWriter sw = new StreamWriter(sOut, Encoding.Default);
                        sw.AutoFlush = true;
                        Console.SetOut(sw);
                    }
                    Stream sErr = Console.OpenStandardError();
                    if (sErr != null && sErr != Stream.Null)
                    {
                        StreamWriter swErr = new StreamWriter(sErr, Encoding.Default);
                        swErr.AutoFlush = true;
                        Console.SetError(swErr);
                    }
                }
            }
            catch { }
        }
    }
    #endregion

    #region Win32 Memory Management Engine
    internal static class MemoryManager
    {
        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool SetProcessWorkingSetSize(IntPtr hProcess, IntPtr dwMinimumWorkingSetSize, IntPtr dwMaximumWorkingSetSize);

        /// <summary>
        /// Forces CLR garbage collection and flushes unused pages from the process working set.
        /// Keeps private memory and working set strictly bounded (< 20 MB).
        /// </summary>
        public static void TrimWorkingSet()
        {
            try
            {
                GC.Collect(2, GCCollectionMode.Forced);
                GC.WaitForPendingFinalizers();
                GC.Collect(2, GCCollectionMode.Forced);

                IntPtr hProcess = Process.GetCurrentProcess().Handle;
                SetProcessWorkingSetSize(hProcess, (IntPtr)(-1), (IntPtr)(-1));
            }
            catch { }
        }
    }
    #endregion

    #region Configuration Engine
    public class CommandLineConfig
    {
        public string ServerUrl { get; set; }
        public string BranchId { get; set; }
        public string Alias { get; set; }
        public string MasterToken { get; set; }
        public string FixedPassword { get; set; }
        public string TempPassword { get; set; }
        public bool TriggerSos { get; set; }
        public bool DebugMode { get; set; }
        public int Fps { get; set; }
        public int Quality { get; set; }

        public CommandLineConfig()
        {
            ServerUrl = "ws://localhost:8080/ws";
            BranchId = "cayma";
            Alias = "AQP-CAYMA-CAJA01";
            MasterToken = "vd-master-token-aqp-production-key-2026";
            FixedPassword = "";
            TempPassword = "";
            TriggerSos = false;
            DebugMode = false;
            Fps = 15;
            Quality = 70;
        }

        public static CommandLineConfig Parse(string[] args)
        {
            CommandLineConfig config = new CommandLineConfig();

            // Check config.json next to executable or working directory
            try
            {
                string exeDir = AppDomain.CurrentDomain.BaseDirectory;
                string cfgPath = Path.Combine(exeDir, "config.json");
                if (!File.Exists(cfgPath))
                {
                    cfgPath = Path.Combine(Environment.CurrentDirectory, "config.json");
                }
                if (File.Exists(cfgPath))
                {
                    string json = File.ReadAllText(cfgPath);
                    string server = ExtractJsonString(json, "serverUrl");
                    if (!string.IsNullOrEmpty(server)) config.ServerUrl = server;
                    string branch = ExtractJsonString(json, "branchId");
                    if (!string.IsNullOrEmpty(branch)) config.BranchId = branch;
                    string alias = ExtractJsonString(json, "alias");
                    if (!string.IsNullOrEmpty(alias)) config.Alias = alias;
                    string token = ExtractJsonString(json, "masterToken");
                    if (!string.IsNullOrEmpty(token)) config.MasterToken = token;
                    string fixedPwd = ExtractJsonString(json, "fixedPassword");
                    if (!string.IsNullOrEmpty(fixedPwd)) config.FixedPassword = fixedPwd;
                    string tempPwd = ExtractJsonString(json, "tempPassword");
                    if (!string.IsNullOrEmpty(tempPwd)) config.TempPassword = tempPwd;
                }
            }
            catch { }

            // Check environment variables first as fallbacks
            string envServer = Environment.GetEnvironmentVariable("VISIONDESK_SERVER");
            if (!string.IsNullOrEmpty(envServer)) config.ServerUrl = envServer;

            string envBranch = Environment.GetEnvironmentVariable("VISIONDESK_BRANCH_ID");
            if (!string.IsNullOrEmpty(envBranch)) config.BranchId = envBranch;

            string envAlias = Environment.GetEnvironmentVariable("VISIONDESK_ALIAS");
            if (!string.IsNullOrEmpty(envAlias)) config.Alias = envAlias;

            string envToken = Environment.GetEnvironmentVariable("VISIONDESK_TOKEN");
            if (!string.IsNullOrEmpty(envToken)) config.MasterToken = envToken;

            string envPwd = Environment.GetEnvironmentVariable("VISIONDESK_FIXED_PWD");
            if (!string.IsNullOrEmpty(envPwd)) config.FixedPassword = envPwd;

            string envTempPwd = Environment.GetEnvironmentVariable("VISIONDESK_TEMP_PWD");
            if (!string.IsNullOrEmpty(envTempPwd)) config.TempPassword = envTempPwd;

            string envTriggerSos = Environment.GetEnvironmentVariable("VISIONDESK_TRIGGER_SOS");
            if (!string.IsNullOrEmpty(envTriggerSos)) config.TriggerSos = (envTriggerSos.Equals("true", StringComparison.OrdinalIgnoreCase) || envTriggerSos == "1");

            for (int i = 0; i < args.Length; i++)
            {
                string arg = args[i];
                if (string.IsNullOrEmpty(arg)) continue;

                if (arg.Equals("--debug", StringComparison.OrdinalIgnoreCase) ||
                    arg.Equals("--console", StringComparison.OrdinalIgnoreCase))
                {
                    config.DebugMode = true;
                    continue;
                }

                if (arg.Equals("--trigger-sos", StringComparison.OrdinalIgnoreCase) ||
                    arg.Equals("--sos", StringComparison.OrdinalIgnoreCase))
                {
                    config.TriggerSos = true;
                    continue;
                }

                if (arg.Equals("--help", StringComparison.OrdinalIgnoreCase) ||
                    arg.Equals("-h", StringComparison.OrdinalIgnoreCase))
                {
                    PrintHelp();
                    Environment.Exit(0);
                }

                string key = arg;
                string val = null;
                int eqIdx = arg.IndexOf('=');
                if (eqIdx > 0)
                {
                    key = arg.Substring(0, eqIdx);
                    val = arg.Substring(eqIdx + 1);
                }
                else if (i + 1 < args.Length && !args[i + 1].StartsWith("--"))
                {
                    val = args[++i];
                }

                if (key.Equals("--server", StringComparison.OrdinalIgnoreCase) && val != null)
                {
                    config.ServerUrl = val.Trim();
                }
                else if (key.Equals("--branchId", StringComparison.OrdinalIgnoreCase) && val != null)
                {
                    config.BranchId = val.Trim();
                }
                else if (key.Equals("--alias", StringComparison.OrdinalIgnoreCase) && val != null)
                {
                    config.Alias = val.Trim();
                }
                else if (key.Equals("--token", StringComparison.OrdinalIgnoreCase) && val != null)
                {
                    config.MasterToken = val.Trim();
                }
                else if (key.Equals("--fixed-pwd", StringComparison.OrdinalIgnoreCase) && val != null)
                {
                    config.FixedPassword = val.Trim();
                }
                else if (key.Equals("--temp-pwd", StringComparison.OrdinalIgnoreCase) && val != null)
                {
                    config.TempPassword = val.Trim();
                }
                else if (key.Equals("--fps", StringComparison.OrdinalIgnoreCase) && val != null)
                {
                    int fps;
                    if (int.TryParse(val, out fps)) config.Fps = Math.Max(1, Math.Min(30, fps));
                }
                else if (key.Equals("--quality", StringComparison.OrdinalIgnoreCase) && val != null)
                {
                    int q;
                    if (int.TryParse(val, out q)) config.Quality = Math.Max(20, Math.Min(100, q));
                }
            }
            return config;
        }

        private static string ExtractJsonString(string json, string key)
        {
            if (string.IsNullOrEmpty(json) || string.IsNullOrEmpty(key)) return null;
            System.Text.RegularExpressions.Match match = System.Text.RegularExpressions.Regex.Match(
                json,
                "\"" + System.Text.RegularExpressions.Regex.Escape(key) + "\"\\s*:\\s*\"([^\"]*)\"",
                System.Text.RegularExpressions.RegexOptions.IgnoreCase
            );
            return match.Success ? match.Groups[1].Value : null;
        }

        private static void PrintHelp()
        {
            NativeMethods.InitConsole();
            Console.WriteLine("VisionDesk Windows Background Agent");
            Console.WriteLine("Usage: VisionDeskAgent.exe [options]");
            Console.WriteLine();
            Console.WriteLine("Options:");
            Console.WriteLine("  --server <url>       WebSocket server URL (default: ws://localhost:8080/ws)");
            Console.WriteLine("  --branchId <id>      Branch ID (e.g. cayma, cerro-colorado, yanahuara)");
            Console.WriteLine("  --alias <string>     Station alias (e.g. AQP-CAYMA-CAJA01)");
            Console.WriteLine("  --token <string>     Master admin token");
            Console.WriteLine("  --fixed-pwd <pwd>    Fixed password for accounting/support access");
            Console.WriteLine("  --temp-pwd <pwd>     Temporary OTP password for ad-hoc support");
            Console.WriteLine("  --trigger-sos        Trigger emergency Reverse SOS alert on startup");
            Console.WriteLine("  --fps <1-30>         Max streaming FPS for active sessions (default: 15)");
            Console.WriteLine("  --quality <20-100>   JPEG streaming quality percentage (default: 70)");
            Console.WriteLine("  --debug, --console   Attach output to caller console window");
            Console.WriteLine("  --help, -h           Show this help text");
        }
    }
    #endregion

    #region Machine ID Provider (Registry & Triplets)
    public static class MachineIdProvider
    {
        public static string GetRawMachineGuid()
        {
            string guid = null;
            try
            {
                using (RegistryKey baseKey = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64))
                using (RegistryKey subKey = baseKey.OpenSubKey(@"SOFTWARE\Microsoft\Cryptography"))
                {
                    if (subKey != null)
                    {
                        object val = subKey.GetValue("MachineGuid");
                        if (val != null) guid = val.ToString();
                    }
                }
            }
            catch { }

            if (string.IsNullOrEmpty(guid))
            {
                try
                {
                    using (RegistryKey key = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Cryptography"))
                    {
                        if (key != null)
                        {
                            object val = key.GetValue("MachineGuid");
                            if (val != null) guid = val.ToString();
                        }
                    }
                }
                catch { }
            }

            if (string.IsNullOrEmpty(guid))
            {
                guid = Environment.MachineName + "_" + Environment.UserName;
            }

            return guid.Trim();
        }

        public static string Generate9DigitId(string machineGuid)
        {
            if (string.IsNullOrEmpty(machineGuid)) machineGuid = Environment.MachineName;
            using (SHA256 sha = SHA256.Create())
            {
                byte[] bytes = Encoding.UTF8.GetBytes(machineGuid.ToLowerInvariant());
                byte[] hash = sha.ComputeHash(bytes);
                ulong uval = BitConverter.ToUInt64(hash, 0);
                ulong idNum = 100000000UL + (uval % 900000000UL);
                return idNum.ToString();
            }
        }

        public static string FormatTriplets(string raw9Digits)
        {
            if (!string.IsNullOrEmpty(raw9Digits) && raw9Digits.Length == 9)
            {
                return string.Format("{0} {1} {2}",
                    raw9Digits.Substring(0, 3),
                    raw9Digits.Substring(3, 3),
                    raw9Digits.Substring(6, 3));
            }
            return raw9Digits;
        }
    }
    #endregion

    #region Zero-Dependency MiniJson Parser & Serializer
    public static class MiniJson
    {
        public static string Serialize(object obj)
        {
            StringBuilder sb = new StringBuilder();
            SerializeValue(obj, sb);
            return sb.ToString();
        }

        private static void SerializeValue(object val, StringBuilder sb)
        {
            if (val == null)
            {
                sb.Append("null");
            }
            else if (val is string)
            {
                sb.Append("\"");
                string s = (string)val;
                for (int i = 0; i < s.Length; i++)
                {
                    char c = s[i];
                    switch (c)
                    {
                        case '"': sb.Append("\\\""); break;
                        case '\\': sb.Append("\\\\"); break;
                        case '\b': sb.Append("\\b"); break;
                        case '\f': sb.Append("\\f"); break;
                        case '\n': sb.Append("\\n"); break;
                        case '\r': sb.Append("\\r"); break;
                        case '\t': sb.Append("\\t"); break;
                        default:
                            if (c < 32) sb.AppendFormat("\\u{0:x4}", (int)c);
                            else sb.Append(c);
                            break;
                    }
                }
                sb.Append("\"");
            }
            else if (val is bool)
            {
                sb.Append((bool)val ? "true" : "false");
            }
            else if (val is int || val is long || val is double || val is float || val is ulong || val is uint || val is short || val is ushort || val is byte || val is sbyte)
            {
                sb.Append(Convert.ToString(val, System.Globalization.CultureInfo.InvariantCulture));
            }
            else if (val is IDictionary<string, object>)
            {
                IDictionary<string, object> dict = (IDictionary<string, object>)val;
                sb.Append("{");
                bool first = true;
                foreach (KeyValuePair<string, object> kvp in dict)
                {
                    if (!first) sb.Append(",");
                    first = false;
                    SerializeValue(kvp.Key, sb);
                    sb.Append(":");
                    SerializeValue(kvp.Value, sb);
                }
                sb.Append("}");
            }
            else if (val is IEnumerable)
            {
                IEnumerable list = (IEnumerable)val;
                sb.Append("[");
                bool first = true;
                foreach (object item in list)
                {
                    if (!first) sb.Append(",");
                    first = false;
                    SerializeValue(item, sb);
                }
                sb.Append("]");
            }
            else
            {
                SerializeValue(val.ToString(), sb);
            }
        }

        public static object Deserialize(string json)
        {
            if (string.IsNullOrEmpty(json)) return null;
            int idx = 0;
            return ParseValue(json, ref idx);
        }

        private static void SkipWhitespace(string s, ref int idx)
        {
            while (idx < s.Length && char.IsWhiteSpace(s[idx])) idx++;
        }

        private static object ParseValue(string s, ref int idx)
        {
            SkipWhitespace(s, ref idx);
            if (idx >= s.Length) return null;

            char c = s[idx];
            if (c == '{') return ParseObject(s, ref idx);
            if (c == '[') return ParseArray(s, ref idx);
            if (c == '"') return ParseString(s, ref idx);
            if (c == 't' || c == 'f') return ParseBool(s, ref idx);
            if (c == 'n') return ParseNull(s, ref idx);
            if (c == '-' || char.IsDigit(c)) return ParseNumber(s, ref idx);

            return null;
        }

        private static Dictionary<string, object> ParseObject(string s, ref int idx)
        {
            Dictionary<string, object> dict = new Dictionary<string, object>(StringComparer.OrdinalIgnoreCase);
            idx++; // skip '{'
            SkipWhitespace(s, ref idx);

            while (idx < s.Length)
            {
                if (s[idx] == '}') { idx++; return dict; }

                string key = ParseString(s, ref idx);
                SkipWhitespace(s, ref idx);
                if (idx < s.Length && s[idx] == ':') idx++;
                SkipWhitespace(s, ref idx);

                object val = ParseValue(s, ref idx);
                dict[key] = val;

                SkipWhitespace(s, ref idx);
                if (idx < s.Length && s[idx] == ',') { idx++; SkipWhitespace(s, ref idx); }
                else if (idx < s.Length && s[idx] == '}') { idx++; return dict; }
            }
            return dict;
        }

        private static List<object> ParseArray(string s, ref int idx)
        {
            List<object> list = new List<object>();
            idx++; // skip '['
            SkipWhitespace(s, ref idx);

            while (idx < s.Length)
            {
                if (s[idx] == ']') { idx++; return list; }

                object val = ParseValue(s, ref idx);
                list.Add(val);

                SkipWhitespace(s, ref idx);
                if (idx < s.Length && s[idx] == ',') { idx++; SkipWhitespace(s, ref idx); }
                else if (idx < s.Length && s[idx] == ']') { idx++; return list; }
            }
            return list;
        }

        private static string ParseString(string s, ref int idx)
        {
            StringBuilder sb = new StringBuilder();
            idx++; // skip '"'
            while (idx < s.Length)
            {
                char c = s[idx++];
                if (c == '"') return sb.ToString();
                if (c == '\\' && idx < s.Length)
                {
                    char esc = s[idx++];
                    switch (esc)
                    {
                        case '"': sb.Append('"'); break;
                        case '\\': sb.Append('\\'); break;
                        case '/': sb.Append('/'); break;
                        case 'b': sb.Append('\b'); break;
                        case 'f': sb.Append('\f'); break;
                        case 'n': sb.Append('\n'); break;
                        case 'r': sb.Append('\r'); break;
                        case 't': sb.Append('\t'); break;
                        case 'u':
                            if (idx + 4 <= s.Length)
                            {
                                string hex = s.Substring(idx, 4);
                                idx += 4;
                                int code;
                                if (int.TryParse(hex, System.Globalization.NumberStyles.HexNumber, null, out code))
                                {
                                    sb.Append((char)code);
                                }
                            }
                            break;
                    }
                }
                else
                {
                    sb.Append(c);
                }
            }
            return sb.ToString();
        }

        private static bool ParseBool(string s, ref int idx)
        {
            if (s.Substring(idx).StartsWith("true", StringComparison.OrdinalIgnoreCase))
            {
                idx += 4;
                return true;
            }
            if (s.Substring(idx).StartsWith("false", StringComparison.OrdinalIgnoreCase))
            {
                idx += 5;
                return false;
            }
            return false;
        }

        private static object ParseNull(string s, ref int idx)
        {
            if (s.Substring(idx).StartsWith("null", StringComparison.OrdinalIgnoreCase))
            {
                idx += 4;
            }
            return null;
        }

        private static object ParseNumber(string s, ref int idx)
        {
            int start = idx;
            while (idx < s.Length && (char.IsDigit(s[idx]) || s[idx] == '.' || s[idx] == '-' || s[idx] == 'e' || s[idx] == 'E' || s[idx] == '+'))
            {
                idx++;
            }
            string numStr = s.Substring(start, idx - start);
            long lval;
            if (long.TryParse(numStr, out lval)) return lval;
            double dval;
            if (double.TryParse(numStr, System.Globalization.NumberStyles.Any, System.Globalization.CultureInfo.InvariantCulture, out dval)) return dval;
            return 0;
        }
    }
    #endregion

    #region Background Agent Main Service Engine
    public class VisionDeskAgentService
    {
        private readonly CommandLineConfig _config;
        private readonly string _rawMachineGuid;
        private readonly string _machineId9;
        private readonly string _formattedId;
        private string _temporaryOtp;
        private ClientWebSocket _ws;
        private CancellationTokenSource _cts;
        private long _lastPingSendTime;
        private long _lastLatencyMs;
        private bool _isRegistered;
        private int _reconnectDelayMs;
        private readonly ScreenCapturer _capturer;
        private readonly InputInjector _inputInjector;
        private readonly WebRtcManager _webrtcManager;
        private readonly SemaphoreSlim _sendLock = new SemaphoreSlim(1, 1);
        private DateTime _lastServerActivity;
        private Action _activeFallbackAction;

        public bool IsRegistered
        {
            get { return _isRegistered; }
        }

        public string TemporaryOtp
        {
            get { return _temporaryOtp; }
        }

        public VisionDeskAgentService(CommandLineConfig config)
        {
            _config = config;
            _rawMachineGuid = MachineIdProvider.GetRawMachineGuid();
            _machineId9 = MachineIdProvider.Generate9DigitId(_rawMachineGuid);
            _formattedId = MachineIdProvider.FormatTriplets(_machineId9);
            _reconnectDelayMs = 2000;

            if (!string.IsNullOrEmpty(_config.TempPassword))
            {
                _temporaryOtp = _config.TempPassword;
            }
            else
            {
                _temporaryOtp = GenerateRandomOtp();
            }

            ScreenCapturerConfig capConfig = new ScreenCapturerConfig();
            capConfig.ThumbnailWidth = 480;
            capConfig.ThumbnailQuality = _config.Quality;
            capConfig.ThumbnailIntervalMs = 5000;
            capConfig.StreamWidth = 1280;
            capConfig.StreamFps = _config.Fps;
            capConfig.StreamQuality = _config.Quality;
            capConfig.PauseThumbnailDuringStream = false;

            _capturer = new ScreenCapturer(capConfig);
            _inputInjector = new InputInjector();

            _webrtcManager = new WebRtcManager(SendSignalingJson, msg => Log(msg));
            _webrtcManager.OnInputPacketReceived = packet =>
            {
                if (packet.Length > 0 && packet[0] == 0x06) { _capturer.Gate.OnAck(); return; }
                _inputInjector.InjectPacket(packet, 0, packet.Length);
            };

            _capturer.OnInputPacketReceived = delegate(byte[] buf, int count)
            {
                if (count > 0 && buf[0] == 0x06) { _capturer.Gate.OnAck(); return; }
                _inputInjector.InjectPacket(buf, 0, count);
            };

            _capturer.OnLogMessage = delegate(string msg)
            {
                Log(msg);
            };

            _lastServerActivity = DateTime.UtcNow;
        }

        public static string GenerateRandomOtp()
        {
            using (RNGCryptoServiceProvider rng = new RNGCryptoServiceProvider())
            {
                byte[] bytes = new byte[4];
                rng.GetBytes(bytes);
                uint rand = BitConverter.ToUInt32(bytes, 0);
                uint code = 100000 + (rand % 900000);
                return code.ToString();
            }
        }

        public string RegenerateOtp()
        {
            _temporaryOtp = GenerateRandomOtp();
            Log(string.Format("Regenerated Temporary OTP: {0}", _temporaryOtp));
            return _temporaryOtp;
        }

        public void Log(string message)
        {
            try
            {
                string ts = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss");
                string line = string.Format("[{0}] [VisionDesk] {1}", ts, message);
                Console.WriteLine(line);
                try
                {
                    File.AppendAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "agent.log"), line + "\r\n");
                }
                catch { }
            }
            catch { }
        }

        private TcpListener _localHttpListener;

        private void StartLocalDiscoveryServer()
        {
            Task.Run(async () =>
            {
                int attempts = 0;
                while (attempts < 15 && (_cts == null || !_cts.IsCancellationRequested))
                {
                    bool bound = false;
                    try
                    {
                        attempts++;
                        _localHttpListener = new TcpListener(IPAddress.Loopback, 18999);
                        _localHttpListener.Server.SetSocketOption(SocketOptionLevel.Socket, SocketOptionName.ReuseAddress, true);
                        _localHttpListener.ExclusiveAddressUse = false;
                        _localHttpListener.Start();
                        Log("Local Station Discovery server active on 127.0.0.1:18999");
                        bound = true;
                    }
                    catch (Exception ex)
                    {
                        if (attempts >= 15)
                        {
                            Log(string.Format("Local Station Discovery server failed to bind 18999 after 15 attempts: {0}", ex.Message));
                            return;
                        }
                    }

                    if (bound) break;
                    await Task.Delay(1000);
                }

                while (_cts != null && !_cts.IsCancellationRequested)
                {
                    try
                    {
                        TcpClient client = await _localHttpListener.AcceptTcpClientAsync();
                        HandleLocalHttpClientAsync(client);
                    }
                    catch
                    {
                        break;
                    }
                }
            });
        }

        private async void HandleLocalHttpClientAsync(TcpClient client)
        {
            using (client)
            {
                try
                {
                    using (NetworkStream stream = client.GetStream())
                    {
                        byte[] buf = new byte[2048];
                        int read = await stream.ReadAsync(buf, 0, buf.Length);
                        if (read > 0)
                        {
                            string req = Encoding.ASCII.GetString(buf, 0, read);
                            string origin = "*";
                            string[] lines = req.Split(new string[] { "\r\n", "\n" }, StringSplitOptions.None);
                            foreach (string line in lines)
                            {
                                if (line.StartsWith("Origin:", StringComparison.OrdinalIgnoreCase))
                                {
                                    origin = line.Substring(7).Trim();
                                    break;
                                }
                            }

                            if (req.StartsWith("OPTIONS", StringComparison.OrdinalIgnoreCase))
                            {
                                string optHeaders = "HTTP/1.1 204 No Content\r\n" +
                                                    "Access-Control-Allow-Origin: " + origin + "\r\n" +
                                                    "Access-Control-Allow-Credentials: true\r\n" +
                                                    "Access-Control-Allow-Methods: GET, OPTIONS, HEAD\r\n" +
                                                    "Access-Control-Allow-Headers: Content-Type, Authorization, X-Requested-With, Range, Access-Control-Request-Private-Network, *\r\n" +
                                                    "Access-Control-Allow-Private-Network: true\r\n" +
                                                    "Vary: Origin, Access-Control-Request-Private-Network\r\n" +
                                                    "Content-Length: 0\r\n" +
                                                    "Connection: close\r\n\r\n";
                                byte[] optBytes = Encoding.ASCII.GetBytes(optHeaders);
                                await stream.WriteAsync(optBytes, 0, optBytes.Length);
                                return;
                            }

                            string json = string.Format(
                                "{{\"found\":true,\"online\":true,\"branchId\":\"{0}\",\"alias\":\"{1}\",\"machineId\":\"{2}\",\"password\":\"{3}\",\"tempPassword\":\"{4}\"}}",
                                EscapeJson(_config.BranchId),
                                EscapeJson(_config.Alias),
                                _machineId9,
                                EscapeJson(_config.FixedPassword),
                                EscapeJson(_temporaryOtp)
                            );
                            byte[] bodyBytes = Encoding.UTF8.GetBytes(json);
                            string headers = "HTTP/1.1 200 OK\r\n" +
                                             "Content-Type: application/json; charset=utf-8\r\n" +
                                             "Access-Control-Allow-Origin: " + origin + "\r\n" +
                                             "Access-Control-Allow-Credentials: true\r\n" +
                                             "Access-Control-Allow-Methods: GET, OPTIONS, HEAD\r\n" +
                                             "Access-Control-Allow-Headers: Content-Type, Authorization, X-Requested-With, Range, Access-Control-Request-Private-Network, *\r\n" +
                                             "Access-Control-Allow-Private-Network: true\r\n" +
                                             "Vary: Origin, Access-Control-Request-Private-Network\r\n" +
                                             "Content-Length: " + bodyBytes.Length + "\r\n" +
                                             "Connection: close\r\n\r\n";
                            byte[] headerBytes = Encoding.ASCII.GetBytes(headers);
                            await stream.WriteAsync(headerBytes, 0, headerBytes.Length);
                            await stream.WriteAsync(bodyBytes, 0, bodyBytes.Length);
                        }
                    }
                }
                catch { }
            }
        }

        private static string EscapeJson(string s)
        {
            if (string.IsNullOrEmpty(s)) return "";
            return s.Replace("\\", "\\\\").Replace("\"", "\\\"");
        }

        public async Task StartAsync()
        {
            if (_config.DebugMode)
            {
                NativeMethods.InitConsole();
            }

            Log("=================================================");
            Log("  VisionDesk Background Agent - Windows 4.8.x   ");
            Log("=================================================");
            Log(string.Format("Branch ID   : {0}", _config.BranchId));
            Log(string.Format("Alias       : {0}", _config.Alias));
            Log(string.Format("Machine ID  : {0} (Raw: {1})", _formattedId, _machineId9));
            Log(string.Format("Server URL  : {0}", _config.ServerUrl));
            Log(string.Format("Fixed PWD   : {0}", string.IsNullOrEmpty(_config.FixedPassword) ? "<Not set>" : "********"));
            Log(string.Format("Temp OTP    : {0}", _temporaryOtp));
            Log(string.Format("Target FPS  : {0} | Quality: {1}%", _config.Fps, _config.Quality));
            Log("-------------------------------------------------");

            _cts = new CancellationTokenSource();
            StartLocalDiscoveryServer();

            while (!_cts.IsCancellationRequested)
            {
                try
                {
                    await ConnectAndRunAsync(_cts.Token);
                }
                catch (OperationCanceledException)
                {
                    break;
                }
                catch (Exception ex)
                {
                    Log(string.Format("Connection error: {0}", ex.Message));
                }

                _isRegistered = false;
                Log(string.Format("Waiting {0} ms before reconnecting...", _reconnectDelayMs));
                try
                {
                    await Task.Delay(_reconnectDelayMs, _cts.Token);
                }
                catch (OperationCanceledException)
                {
                    break;
                }

                _reconnectDelayMs = Math.Min(30000, _reconnectDelayMs * 2);
            }
        }

        private async Task ConnectAndRunAsync(CancellationToken token)
        {
            using (_ws = new ClientWebSocket())
            {
                _ws.Options.KeepAliveInterval = TimeSpan.FromSeconds(15);
                Uri serverUri = new Uri(_config.ServerUrl);
                Log(string.Format("Connecting to {0}...", serverUri));

                await _ws.ConnectAsync(serverUri, token);
                Log("WebSocket connected! Sending registration...");

                _reconnectDelayMs = 2000;
                _lastServerActivity = DateTime.UtcNow;

                await SendRegistrationAsync(token);

                // CONNECTION-SCOPED CTS: Binds all connection background loops to this socket's lifecycle
                using (CancellationTokenSource connCts = CancellationTokenSource.CreateLinkedTokenSource(token))
                {
                    Task receiveTask = ReceiveLoopAsync(connCts.Token);
                    Task heartbeatTask = HeartbeatLoopAsync(connCts.Token);
                    Task thumbnailTask = _capturer.RunThumbnailLoopAsync(
                        delegate(string json)
                        {
                            return SendSignalingTextAsync(json, connCts.Token);
                        },
                        _config.BranchId,
                        connCts.Token);
                    Task watchdogTask = WatchdogLoopAsync(connCts.Token);

                    if (_config.TriggerSos)
                    {
                        Task sosTask = Task.Run(async delegate()
                        {
                            try
                            {
                                await Task.Delay(500, connCts.Token);
                                await SendSosAlertAsync("Alerta de emergencia SOS activada desde linea de comandos", "high", connCts.Token);
                            }
                            catch { }
                        });
                    }

                    // Wait until ANY loop faults or finishes (e.g. socket drops, server closes)
                    Task finishedTask = await Task.WhenAny(receiveTask, heartbeatTask, thumbnailTask, watchdogTask);
                    string taskName = (finishedTask == receiveTask) ? "receive" :
                                      (finishedTask == heartbeatTask) ? "heartbeat" :
                                      (finishedTask == thumbnailTask) ? "thumbnail" : "watchdog";
                    Log(string.Format("Loop task '{0}' finished (Status: {1}, Exception: {2}). Commencing reconnect cycle...",
                        taskName, finishedTask.Status, finishedTask.Exception != null ? finishedTask.Exception.ToString() : "none"));

                    // CRITICAL: Immediately cancel all peer loops so no duplicate tasks survive reconnect
                    connCts.Cancel();

                    // Await all tasks to guarantee complete termination before returning
                    try
                    {
                        await Task.WhenAll(receiveTask, heartbeatTask, thumbnailTask, watchdogTask);
                    }
                    catch (Exception)
                    {
                        // Cleanly ignore OperationCanceledException or socket abort errors
                    }
                }

                // Stop any live streaming session if active
                _capturer.StopLiveStreaming();

                if (_ws.State == WebSocketState.Open)
                {
                    try
                    {
                        await _ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "Agent closing", CancellationToken.None);
                    }
                    catch { }
                }
            }

            // Post-disconnect memory trim to clean up connection-lifetime buffers
            MemoryManager.TrimWorkingSet();
        }

        private async Task SendSignalingTextAsync(string json, CancellationToken token)
        {
            if (_ws == null || _ws.State != WebSocketState.Open) return;

            try
            {
                await _sendLock.WaitAsync(token);
            }
            catch { return; }

            try
            {
                if (_ws != null && _ws.State == WebSocketState.Open)
                {
                    byte[] bytes = Encoding.UTF8.GetBytes(json);
                    await _ws.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, token);
                }
            }
            catch (Exception ex)
            {
                Log(string.Format("Socket send error: {0}", ex.Message));
            }
            finally
            {
                _sendLock.Release();
            }
        }

        private void SendSignalingJson(string json)
        {
            if (_ws != null && _ws.State == WebSocketState.Open)
            {
                Task.Run(delegate()
                {
                    return SendSignalingTextAsync(json, CancellationToken.None);
                });
            }
        }

        private async Task SendRegistrationAsync(CancellationToken token)
        {
            Dictionary<string, object> sysInfo = new Dictionary<string, object>();
            sysInfo["os"] = Environment.OSVersion.VersionString;
            sysInfo["resolution"] = string.Format("{0}x{1}", Screen.PrimaryScreen.Bounds.Width, Screen.PrimaryScreen.Bounds.Height);
            sysInfo["agentVersion"] = "1.0.0";
            sysInfo["hostname"] = Environment.MachineName;
            sysInfo["username"] = Environment.UserName;

            Dictionary<string, object> payload = new Dictionary<string, object>();
            payload["branchId"] = _config.BranchId;
            payload["branchName"] = GetBranchDisplayName(_config.BranchId);
            payload["machineId"] = _machineId9;
            payload["alias"] = _config.Alias;
            payload["authMode"] = "both";
            payload["hasFixedPassword"] = !string.IsNullOrEmpty(_config.FixedPassword);
            payload["hasTemporaryOtp"] = !string.IsNullOrEmpty(_temporaryOtp);
            payload["fixedPassword"] = _config.FixedPassword ?? "";
            payload["tempPassword"] = _temporaryOtp ?? "";
            payload["authModes"] = new string[] { "fixed", "otp", "prompt" };
            payload["systemInfo"] = sysInfo;

            Dictionary<string, object> msg = new Dictionary<string, object>();
            msg["type"] = "agent:register";
            msg["payload"] = payload;

            string json = MiniJson.Serialize(msg);
            await SendSignalingTextAsync(json, token);
            Log(string.Format("Sent agent:register for {0} (MachineId: {1})", _config.BranchId, _machineId9));
        }

        private string GetBranchDisplayName(string id)
        {
            if (string.IsNullOrEmpty(id)) return "Arequipa Branch";
            string lower = id.ToLowerInvariant();
            if (lower.Contains("cayma")) return "Cayma";
            if (lower.Contains("cerro")) return "Cerro Colorado";
            if (lower.Contains("yana")) return "Yanahuara";
            if (lower.Contains("pauc")) return "Paucarpata";
            if (lower.Contains("bustamante") || lower.Contains("jlbr")) return "J.L. Bustamante y Rivero";
            if (lower.Contains("centro")) return "Centro Histórico";
            return id;
        }

        private async Task HeartbeatLoopAsync(CancellationToken token)
        {
            int hbCycle = 0;
            try
            {
                while (!token.IsCancellationRequested && _ws != null && _ws.State == WebSocketState.Open)
                {
                    await Task.Delay(5000, token);
                    if (_ws.State != WebSocketState.Open || !_isRegistered) continue;

                    long now = (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
                    _lastPingSendTime = now;

                    Dictionary<string, object> payload = new Dictionary<string, object>();
                    payload["branchId"] = _config.BranchId;
                    payload["timestamp"] = now;

                    Dictionary<string, object> msg = new Dictionary<string, object>();
                    msg["type"] = "agent:heartbeat";
                    msg["payload"] = payload;

                    string json = MiniJson.Serialize(msg);
                    await SendSignalingTextAsync(json, token);

                    hbCycle++;
                    // Periodic memory trim every ~30 seconds (6 heartbeats)
                    if (hbCycle % 6 == 0)
                    {
                        MemoryManager.TrimWorkingSet();
                    }
                }
            }
            catch (OperationCanceledException)
            {
                // Clean cancellation on disconnect
            }
            catch (Exception ex)
            {
                Log(string.Format("Heartbeat loop error: {0}", ex.Message));
            }
        }

        private async Task WatchdogLoopAsync(CancellationToken token)
        {
            try
            {
                while (!token.IsCancellationRequested && _ws != null && _ws.State == WebSocketState.Open)
                {
                    await Task.Delay(5000, token);
                    if ((DateTime.UtcNow - _lastServerActivity).TotalSeconds > 25)
                    {
                        Log("Dead socket detected (>25s inactivity). Forcing reconnect...");
                        try { _ws.Abort(); } catch { }
                        break;
                    }
                }
            }
            catch (OperationCanceledException)
            {
                // Clean cancellation on disconnect
            }
            catch (Exception ex)
            {
                Log(string.Format("Watchdog loop error: {0}", ex.Message));
            }
        }

        private async Task ReceiveLoopAsync(CancellationToken token)
        {
            byte[] buffer = new byte[65536];
            StringBuilder sb = new StringBuilder();

            try
            {
                while (!token.IsCancellationRequested && _ws != null && _ws.State == WebSocketState.Open)
                {
                    WebSocketReceiveResult result = await _ws.ReceiveAsync(new ArraySegment<byte>(buffer), token);
                    _lastServerActivity = DateTime.UtcNow;

                    if (result.MessageType == WebSocketMessageType.Close)
                    {
                        Log("Server requested close.");
                        break;
                    }

                    if (result.MessageType == WebSocketMessageType.Text)
                    {
                        sb.Append(Encoding.UTF8.GetString(buffer, 0, result.Count));
                        if (result.EndOfMessage)
                        {
                            string messageText = sb.ToString();
                            sb.Clear();
                            HandleServerMessage(messageText);
                        }
                    }
                }
            }
            catch (OperationCanceledException)
            {
                // Clean cancellation on disconnect
            }
            catch (Exception ex)
            {
                Log(string.Format("Receive loop error: {0}", ex.Message));
            }
        }

        private void HandleServerMessage(string json)
        {
            object raw = MiniJson.Deserialize(json);
            Dictionary<string, object> msg = raw as Dictionary<string, object>;
            if (msg == null) return;

            object typeObj;
            if (!msg.TryGetValue("type", out typeObj) || typeObj == null) return;
            string type = typeObj.ToString();

            Dictionary<string, object> payload = null;
            object payloadObj;
            if (msg.TryGetValue("payload", out payloadObj))
            {
                payload = payloadObj as Dictionary<string, object>;
            }

            switch (type)
            {
                case "agent:register_ack":
                    _isRegistered = true;
                    _reconnectDelayMs = 2000;
                    Log("Successfully registered with Central Server!");
                    MemoryManager.TrimWorkingSet();
                    break;

                case "agent:heartbeat_ack":
                    long now = (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
                    if (_lastPingSendTime > 0)
                    {
                        _lastLatencyMs = Math.Max(1, now - _lastPingSendTime);
                    }
                    if (payload != null && payload.ContainsKey("rttMs"))
                    {
                        long srvRtt = Convert.ToInt64(payload["rttMs"]);
                        Log(string.Format("Heartbeat ACK | Latency RTT: {0} ms (Server: {1} ms)", _lastLatencyMs, srvRtt));
                    }
                    else
                    {
                        Log(string.Format("Heartbeat ACK | Latency RTT: {0} ms", _lastLatencyMs));
                    }
                    break;

                case "session:start":
                    HandleSessionStart(payload);
                    break;

                case "session:stop":
                    HandleSessionStop(payload);
                    break;

                case "webrtc:signal":
                    HandleWebRtcSignal(payload);
                    break;

                case "webrtc:close":
                    HandleWebRtcClose(payload);
                    break;

                case "peer:auth_request":
                    HandlePeerAuthRequest(payload);
                    break;

                case "sos:alert_ack":
                    Log("SOS Alert acknowledged by Central Server.");
                    break;

                case "sos:cleared":
                    Log("SOS Alert cleared by Central Server.");
                    break;

                default:
                    Log(string.Format("Received message: {0}", type));
                    break;
            }
        }

        private void HandleSessionStart(Dictionary<string, object> payload)
        {
            if (payload == null) return;
            string sessionId = payload.ContainsKey("sessionId") ? Convert.ToString(payload["sessionId"]) : "";
            string mode = payload.ContainsKey("mode") ? Convert.ToString(payload["mode"]) : "observe";
            string token = payload.ContainsKey("adminToken") ? Convert.ToString(payload["adminToken"]) : "";
            string transport = payload.ContainsKey("transport") ? Convert.ToString(payload["transport"]) : "relay";
            bool renegotiate = payload.ContainsKey("renegotiate") && Convert.ToBoolean(payload["renegotiate"]);

            Log(string.Format(">>> SESSION START REQUEST: ID={0}, Mode={1}, Transport={2}, Renegotiate={3}", sessionId, mode, transport, renegotiate));

            if (!string.IsNullOrEmpty(_config.MasterToken) && token != _config.MasterToken)
            {
                Log(string.Format("Session {0} REJECTED: Invalid master admin token", sessionId));
                return;
            }

            Log(string.Format("Session {0} AUTHORIZED in mode [{1}]", sessionId, mode));

            // Configure input injection guard based on session mode
            _inputInjector.SetSession(sessionId, mode, true);

            // Construct relay WebSocket URL from server URL
            string relayUrl = _config.ServerUrl;
            int idx = relayUrl.LastIndexOf("/ws", StringComparison.OrdinalIgnoreCase);
            if (idx >= 0)
            {
                relayUrl = relayUrl.Substring(0, idx) + "/ws/relay";
            }
            else
            {
                relayUrl = relayUrl.TrimEnd('/') + "/relay";
            }

            // Extract ICE servers if provided
            List<object> iceServers = null;
            if (payload.ContainsKey("iceServers") && payload["iceServers"] is List<object>)
            {
                iceServers = (List<object>)payload["iceServers"];
            }

            int fallbackTriggered = 0;
            Action triggerFallback = () =>
            {
                if (Interlocked.CompareExchange(ref fallbackTriggered, 1, 0) == 0)
                {
                    Log(string.Format("WebRTC fallback triggered for session {0}. Conmutating seamlessly to Tier 3 WebSocket relay...", sessionId));
                    Task.Run(delegate()
                    {
                        return _capturer.StartLiveStreamingAsync(relayUrl, sessionId, mode, token, _cts.Token);
                    });
                }
            };

            _activeFallbackAction = triggerFallback;

            // When transport is 'relay' (default) and NOT renegotiating P2P:
            // Immediately start the live streaming loop via _capturer.StartLiveStreamingAsync(...)
            // without initializing WebRTC or waiting for the 6-second watchdog.
            if (string.Equals(transport, "relay", StringComparison.OrdinalIgnoreCase) && !renegotiate)
            {
                Log(string.Format("Session {0} starting directly in WebSocket Relay mode (110ms / 15 FPS continuous and stable)", sessionId));
                Task.Run(delegate()
                {
                    return _capturer.StartLiveStreamingAsync(relayUrl, sessionId, mode, token, _cts.Token);
                });
                return;
            }

            // Otherwise (transport is 'p2p' or renegotiate is true):
            // Tier 1 / Tier 2: Initialize WebRTC P2P Direct & TURN Engine
            Log(string.Format("Initiating WebRTC P2P negotiation for session {0} (renegotiate={1})...", sessionId, renegotiate));
            _webrtcManager.Initialize(sessionId, iceServers);
            _webrtcManager.OnFallbackRequired = triggerFallback;
            int streamStarted = 0;
            _webrtcManager.OnConnected = () =>
            {
                if (Interlocked.CompareExchange(ref streamStarted, 1, 0) == 0)
                {
                    Log(string.Format("WebRTC P2P direct data channel connected for session {0}!", sessionId));
                    _webrtcManager.OptimizeSctpStack();
                    Task.Run(delegate()
                    {
                        return _capturer.StartWebRtcStreamingAsync(_webrtcManager, mode, _cts.Token);
                    });
                }
            };

            // 6s Watchdog Failover: If WebRTC DataChannel is not open within 6s, activate Tier 3 Relay
            Task.Run(async delegate()
            {
                await Task.Delay(6000);
                if (!_webrtcManager.IsConnected && fallbackTriggered == 0)
                {
                    Log("Agent WebRTC watchdog (6s) expired before DataChannel opened. Executing Tier 3 fallback.");
                    triggerFallback();
                }
            });
        }

        private void HandleWebRtcSignal(Dictionary<string, object> payload)
        {
            if (payload == null || _webrtcManager == null) return;
            string sessionId = payload.ContainsKey("sessionId") ? Convert.ToString(payload["sessionId"]) : "";

            Log(string.Format("Received WebRTC signal for session {0}", sessionId));

            // Extract signal dictionary from either "data", "signal", or payload root
            Dictionary<string, object> sigData = null;
            if (payload.ContainsKey("data") && payload["data"] is Dictionary<string, object>)
            {
                sigData = (Dictionary<string, object>)payload["data"];
            }
            else if (payload.ContainsKey("signal") && payload["signal"] is Dictionary<string, object>)
            {
                sigData = (Dictionary<string, object>)payload["signal"];
            }
            else
            {
                sigData = payload;
            }

            string sigType = "";
            if (payload.ContainsKey("signalType")) sigType = Convert.ToString(payload["signalType"]);
            else if (sigData != null && sigData.ContainsKey("type")) sigType = Convert.ToString(sigData["type"]);
            else if (payload.ContainsKey("type")) sigType = Convert.ToString(payload["type"]);

            Log(string.Format("Processing WebRTC signal type: [{0}]", sigType));

            if (sigType == "offer")
            {
                string sdp = (sigData != null && sigData.ContainsKey("sdp")) ? Convert.ToString(sigData["sdp"]) : "";
                Task.Run(async delegate()
                {
                    await _webrtcManager.HandleRemoteOfferAsync(sdp);
                });
            }
            else if (sigType == "answer")
            {
                string sdp = (sigData != null && sigData.ContainsKey("sdp")) ? Convert.ToString(sigData["sdp"]) : "";
                _webrtcManager.HandleRemoteAnswer(sdp);
            }
            else if (sigType == "candidate")
            {
                if (sigData != null && sigData.ContainsKey("candidate") && sigData["candidate"] is Dictionary<string, object>)
                {
                    var candDict = (Dictionary<string, object>)sigData["candidate"];
                    _webrtcManager.HandleRemoteCandidate(candDict);
                }
                else if (sigData != null && sigData.ContainsKey("candidate"))
                {
                    _webrtcManager.HandleRemoteCandidate(sigData);
                }
            }
        }

        private void HandleWebRtcClose(Dictionary<string, object> payload)
        {
            Log("WebRTC close signal received from peer.");
            if (_webrtcManager != null) _webrtcManager.Close();
            if (_capturer != null) _capturer.Gate.Reset();
            if (_activeFallbackAction != null)
            {
                _activeFallbackAction();
            }
        }

        private void HandleSessionStop(Dictionary<string, object> payload)
        {
            if (payload == null) return;
            string sessionId = payload.ContainsKey("sessionId") ? Convert.ToString(payload["sessionId"]) : "";
            Log(string.Format("<<< SESSION STOP REQUEST: ID={0}", sessionId));

            _activeFallbackAction = null;
            _inputInjector.ResetSession();
            if (_webrtcManager != null) _webrtcManager.Close();
            _capturer.StopLiveStreaming();
            if (_capturer != null) _capturer.Gate.Reset();
            AuthDialog.DismissActiveDialog(sessionId);
            MemoryManager.TrimWorkingSet();
        }

        private void HandlePeerAuthRequest(Dictionary<string, object> payload)
        {
            if (payload == null) return;
            string sessionId = payload.ContainsKey("sessionId") ? Convert.ToString(payload["sessionId"]) : "";
            string reqId = payload.ContainsKey("requesterId") ? Convert.ToString(payload["requesterId"]) : "";
            string reqName = payload.ContainsKey("requesterName") ? Convert.ToString(payload["requesterName"]) : "Unknown";
            string targetMachineId = payload.ContainsKey("targetMachineId") ? Convert.ToString(payload["targetMachineId"]) : "";
            string method = payload.ContainsKey("authMethod") ? Convert.ToString(payload["authMethod"]) : "prompt";
            string pwd = payload.ContainsKey("password") ? Convert.ToString(payload["password"]) : "";

            List<object> iceServers = null;
            if (payload.ContainsKey("iceServers") && payload["iceServers"] is List<object>)
            {
                iceServers = (List<object>)payload["iceServers"];
            }
            string transport = payload.ContainsKey("transport") ? Convert.ToString(payload["transport"]) : "relay";

            Log(string.Format("Peer Support Auth Request: ID={0}, Requester='{1}', Method='{2}', Transport='{3}'", sessionId, reqName, method, transport));

            if (method.Equals("password", StringComparison.OrdinalIgnoreCase))
            {
                bool ok = (!string.IsNullOrEmpty(_config.FixedPassword) && pwd == _config.FixedPassword);
                if (!ok && !string.IsNullOrEmpty(_temporaryOtp) && pwd == _temporaryOtp)
                {
                    // Fallback acceptance if OTP was provided in password field
                    OnPeerAuthGranted(sessionId, "control", iceServers, transport);
                    SendPeerAuthResponse(sessionId, true, "valid_otp");
                    return;
                }

                if (ok)
                {
                    OnPeerAuthGranted(sessionId, "control", iceServers, transport);
                }
                SendPeerAuthResponse(sessionId, ok, ok ? "valid_password" : "invalid_password");
            }
            else if (method.Equals("otp", StringComparison.OrdinalIgnoreCase))
            {
                bool ok = (!string.IsNullOrEmpty(_temporaryOtp) && pwd == _temporaryOtp);
                if (ok)
                {
                    OnPeerAuthGranted(sessionId, "control", iceServers, transport);
                }
                SendPeerAuthResponse(sessionId, ok, ok ? "valid_otp" : "invalid_otp");
            }
            else
            {
                Log(string.Format("Prompting user for connection authorization from '{0}'...", reqName));
                AuthPromptRequest promptReq = new AuthPromptRequest();
                promptReq.SessionId = sessionId;
                promptReq.RequesterId = reqId;
                promptReq.RequesterName = reqName;
                promptReq.TargetMachineId = targetMachineId;
                promptReq.TimeoutSeconds = 30;

                Task.Run(async delegate()
                {
                    AuthPromptResponse resp = await AuthDialog.ShowPromptAsync(promptReq);
                    if (resp.Granted)
                    {
                        OnPeerAuthGranted(resp.SessionId, "control", iceServers, transport);
                    }
                    SendPeerAuthResponse(resp.SessionId, resp.Granted, resp.Reason);
                });
            }
        }

        private void OnPeerAuthGranted(string sessionId, string mode, List<object> iceServers, string transport = "relay")
        {
            Log(string.Format("Peer Auth GRANTED for session {0} in mode [{1}], Transport={2} - Initializing transports...", sessionId, mode, transport));
            _inputInjector.SetSession(sessionId, mode, true);

            // Construct relay WebSocket URL from server URL
            string relayUrl = _config.ServerUrl;
            int idx = relayUrl.LastIndexOf("/ws", StringComparison.OrdinalIgnoreCase);
            if (idx >= 0)
            {
                relayUrl = relayUrl.Substring(0, idx) + "/ws/relay";
            }
            else
            {
                relayUrl = relayUrl.TrimEnd('/') + "/relay";
            }

            int fallbackTriggered = 0;
            Action triggerFallback = () =>
            {
                if (Interlocked.CompareExchange(ref fallbackTriggered, 1, 0) == 0)
                {
                    Log(string.Format("Peer WebRTC fallback triggered for session {0}. Switching to Tier 3 WebSocket relay...", sessionId));
                    Task.Run(delegate()
                    {
                        return _capturer.StartLiveStreamingAsync(relayUrl, sessionId, mode, "peer-authorized", _cts.Token);
                    });
                }
            };

            _activeFallbackAction = triggerFallback;

            // When transport is 'relay' (default):
            // Immediately start the live streaming loop via _capturer.StartLiveStreamingAsync(...)
            // without initializing WebRTC or waiting for the 6-second watchdog.
            if (string.Equals(transport, "relay", StringComparison.OrdinalIgnoreCase))
            {
                Log(string.Format("Peer session {0} starting directly in WebSocket Relay mode (110ms / 15 FPS continuous)", sessionId));
                Task.Run(delegate()
                {
                    return _capturer.StartLiveStreamingAsync(relayUrl, sessionId, mode, "peer-authorized", _cts.Token);
                });
                return;
            }

            // Tier 1 / Tier 2: Initialize WebRTC P2P Direct & TURN Engine
            _webrtcManager.Initialize(sessionId, iceServers);
            _webrtcManager.OnFallbackRequired = triggerFallback;
            int streamStarted = 0;
            _webrtcManager.OnConnected = () =>
            {
                if (Interlocked.CompareExchange(ref streamStarted, 1, 0) == 0)
                {
                    Log(string.Format("Peer WebRTC P2P connected for session {0}!", sessionId));
                    _webrtcManager.OptimizeSctpStack();
                    Task.Run(delegate()
                    {
                        return _capturer.StartWebRtcStreamingAsync(_webrtcManager, mode, _cts.Token);
                    });
                }
            };

            // 6s Watchdog Failover: If WebRTC DataChannel is not open within 6s, activate Tier 3 Relay
            Task.Run(async delegate()
            {
                await Task.Delay(6000);
                if (!_webrtcManager.IsConnected && fallbackTriggered == 0)
                {
                    Log("Peer WebRTC watchdog (6s) expired. Executing Tier 3 fallback.");
                    triggerFallback();
                }
            });
        }

        public async Task SendSosAlertAsync(string reason, string urgency, CancellationToken token)
        {
            if (_ws == null || _ws.State != WebSocketState.Open) return;

            long now = (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
            Dictionary<string, object> payload = new Dictionary<string, object>();
            payload["branchId"] = _config.BranchId;
            payload["machineId"] = _machineId9;
            payload["alias"] = _config.Alias;
            payload["reason"] = string.IsNullOrEmpty(reason) ? "Fallo critico en caja / Asistencia requerida" : reason;
            payload["urgency"] = string.IsNullOrEmpty(urgency) ? "high" : urgency;
            payload["timestamp"] = now;

            Dictionary<string, object> msg = new Dictionary<string, object>();
            msg["type"] = "sos:alert";
            msg["payload"] = payload;

            string json = MiniJson.Serialize(msg);
            await SendSignalingTextAsync(json, token);
            Log(string.Format("🚨 Sent SOS Alert: '{0}' (Urgency: {1})", payload["reason"], payload["urgency"]));
        }

        private async void SendPeerAuthResponse(string sessionId, bool granted, string reason)
        {
            if (_ws == null || _ws.State != WebSocketState.Open) return;

            Dictionary<string, object> payload = new Dictionary<string, object>();
            payload["sessionId"] = sessionId;
            payload["granted"] = granted;
            payload["reason"] = reason;

            Dictionary<string, object> msg = new Dictionary<string, object>();
            msg["type"] = "peer:auth_response";
            msg["payload"] = payload;

            string json = MiniJson.Serialize(msg);
            await SendSignalingTextAsync(json, CancellationToken.None);
            Log(string.Format("Sent peer:auth_response: granted={0}, reason={1}", granted, reason));
        }
    }
    #endregion

    #region Application Entry Point
    class Program
    {
        [STAThread]
        static void Main(string[] args)
        {
            try
            {
                AppDomain.CurrentDomain.AssemblyResolve += (sender, resolveArgs) =>
                {
                    try
                    {
                        string name = new System.Reflection.AssemblyName(resolveArgs.Name).Name + ".dll";
                        string baseDir = AppDomain.CurrentDomain.BaseDirectory;
                        string direct = Path.Combine(baseDir, name);
                        if (File.Exists(direct)) return System.Reflection.Assembly.LoadFrom(direct);
                        string libPath = Path.Combine(baseDir, "lib", name);
                        if (File.Exists(libPath)) return System.Reflection.Assembly.LoadFrom(libPath);
                    }
                    catch (Exception ex)
                    {
                        try { File.AppendAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "crash.log"), "AssemblyResolve error: " + ex + "\r\n"); } catch { }
                    }
                    return null;
                };

                AppDomain.CurrentDomain.UnhandledException += (sender, eventArgs) =>
                {
                    try
                    {
                        string logPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "crash.log");
                        File.AppendAllText(logPath, string.Format("[{0}] UnhandledException: {1}\r\n", DateTime.Now, eventArgs.ExceptionObject));
                    }
                    catch { }
                };
                TaskScheduler.UnobservedTaskException += (sender, eventArgs) =>
                {
                    try
                    {
                        string logPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "crash.log");
                        File.AppendAllText(logPath, string.Format("[{0}] UnobservedTaskException: {1}\r\n", DateTime.Now, eventArgs.Exception));
                    }
                    catch { }
                    eventArgs.SetObserved();
                };

                CommandLineConfig config = CommandLineConfig.Parse(args);
                VisionDeskAgentService service = new VisionDeskAgentService(config);
                service.StartAsync().GetAwaiter().GetResult();
            }
            catch (Exception ex)
            {
                try
                {
                    File.WriteAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "crash.log"), "Fatal startup failure: " + ex + "\r\n");
                }
                catch { }
            }
        }
    }
    #endregion
}
