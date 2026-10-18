// ============================================================================
// VisionDesk - Windows Background Agent
// File: agent/InputInjector.cs
//
// Native Win32 SendInput Mouse and Keyboard Injection Driver.
// Strictly guarded by active session mode ('control') and authorization state.
// Compatible with .NET Framework 4.8 / C# 5 (csc.exe build).
// ============================================================================

using System;
using System.Collections.Generic;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace VisionDesk.Agent
{
    #region Win32 P/Invoke Structs and Constants

    internal static class NativeInput
    {
        public const uint INPUT_MOUSE = 0;
        public const uint INPUT_KEYBOARD = 1;
        public const uint INPUT_HARDWARE = 2;

        public const uint MOUSEEVENTF_MOVE = 0x0001;
        public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
        public const uint MOUSEEVENTF_LEFTUP = 0x0004;
        public const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
        public const uint MOUSEEVENTF_RIGHTUP = 0x0010;
        public const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
        public const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
        public const uint MOUSEEVENTF_XDOWN = 0x0080;
        public const uint MOUSEEVENTF_XUP = 0x0100;
        public const uint MOUSEEVENTF_WHEEL = 0x0800;
        public const uint MOUSEEVENTF_HWHEEL = 0x1000;
        public const uint MOUSEEVENTF_VIRTUALDESK = 0x4000;
        public const uint MOUSEEVENTF_ABSOLUTE = 0x8000;

        public const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
        public const uint KEYEVENTF_KEYUP = 0x0002;
        public const uint KEYEVENTF_UNICODE = 0x0004;
        public const uint KEYEVENTF_SCANCODE = 0x0008;

        public const uint MAPVK_VK_TO_VSC = 0;

        public const int VK_SHIFT = 0x10;
        public const int VK_CONTROL = 0x11;
        public const int VK_MENU = 0x12; // Alt
        public const int VK_LWIN = 0x5B;
        public const int VK_RWIN = 0x5C;

        [StructLayout(LayoutKind.Sequential)]
        public struct INPUT
        {
            public uint type;
            public InputUnion u;
        }

        [StructLayout(LayoutKind.Explicit)]
        public struct InputUnion
        {
            [FieldOffset(0)]
            public MOUSEINPUT mi;

            [FieldOffset(0)]
            public KEYBDINPUT ki;

            [FieldOffset(0)]
            public HARDWAREINPUT hi;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct MOUSEINPUT
        {
            public int dx;
            public int dy;
            public uint mouseData;
            public uint dwFlags;
            public uint time;
            public UIntPtr dwExtraInfo;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct KEYBDINPUT
        {
            public ushort wVk;
            public ushort wScan;
            public uint dwFlags;
            public uint time;
            public UIntPtr dwExtraInfo;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct HARDWAREINPUT
        {
            public uint uMsg;
            public ushort wParamL;
            public ushort wParamH;
        }

        [DllImport("user32.dll", SetLastError = true)]
        public static extern uint SendInput(uint nInputs, [MarshalAs(UnmanagedType.LPArray), In] INPUT[] pInputs, int cbSize);

        [DllImport("user32.dll")]
        public static extern uint MapVirtualKey(uint uCode, uint uMapType);

        [DllImport("user32.dll")]
        public static extern short GetKeyState(int nVirtKey);

        [DllImport("user32.dll")]
        public static extern short GetAsyncKeyState(int nVirtKey);
    }

    #endregion

    /// <summary>
    /// Thread-safe Win32 input injector with strict state guarding and telemetry.
    /// </summary>
    public class InputInjector
    {
        private readonly object _stateLock = new object();
        private readonly object _keysLock = new object();

        // Active Session State
        private string _activeSessionId;
        private string _activeSessionMode; // "observe", "control", null
        private bool _isAuthorized;

        // Button tracking for stuck-key / drag immunity
        private bool _leftButtonDown;
        private bool _rightButtonDown;
        private bool _middleButtonDown;
        private readonly HashSet<ushort> _pressedKeys = new HashSet<ushort>();

        // Operational Telemetry Counters
        private long _totalPacketsReceived;
        private long _totalMouseInjected;
        private long _totalKeyboardInjected;
        private long _droppedPacketsCount;
        private long _invalidPacketsCount;

        public InputInjector()
        {
            _activeSessionId = null;
            _activeSessionMode = null;
            _isAuthorized = false;
        }

        #region State Properties

        /// <summary>
        /// True strictly when session mode == 'control' AND authorization is active.
        /// In Observe mode or unauthorized state, this returns false.
        /// </summary>
        public bool IsControlAuthorized
        {
            get
            {
                lock (_stateLock)
                {
                    return _isAuthorized &&
                           string.Equals(_activeSessionMode, "control", StringComparison.OrdinalIgnoreCase) &&
                           !string.IsNullOrEmpty(_activeSessionId);
                }
            }
        }

        public string ActiveSessionId
        {
            get { lock (_stateLock) { return _activeSessionId; } }
        }

        public string ActiveSessionMode
        {
            get { lock (_stateLock) { return _activeSessionMode; } }
        }

        public long TotalPacketsReceived { get { return Interlocked.Read(ref _totalPacketsReceived); } }
        public long TotalMouseInjected { get { return Interlocked.Read(ref _totalMouseInjected); } }
        public long TotalKeyboardInjected { get { return Interlocked.Read(ref _totalKeyboardInjected); } }
        public long DroppedPacketsCount { get { return Interlocked.Read(ref _droppedPacketsCount); } }
        public long InvalidPacketsCount { get { return Interlocked.Read(ref _invalidPacketsCount); } }

        #endregion

        #region Session Management

        /// <summary>
        /// Configures the active session mode and authorization state.
        /// If control authority is revoked, automatically releases all pressed inputs.
        /// </summary>
        public void SetSession(string sessionId, string mode, bool authorized)
        {
            lock (_stateLock)
            {
                bool wasActive = (_isAuthorized && string.Equals(_activeSessionMode, "control", StringComparison.OrdinalIgnoreCase));
                _activeSessionId = sessionId;
                _activeSessionMode = mode != null ? mode.Trim().ToLowerInvariant() : null;
                _isAuthorized = authorized;

                bool isNowActive = (_isAuthorized && string.Equals(_activeSessionMode, "control", StringComparison.OrdinalIgnoreCase));
                if (wasActive && !isNowActive)
                {
                    ReleaseAllInputs();
                }
            }
        }

        /// <summary>
        /// Updates the authorization flag of the active session.
        /// </summary>
        public void SetAuthorization(bool authorized)
        {
            lock (_stateLock)
            {
                bool wasActive = (_isAuthorized && string.Equals(_activeSessionMode, "control", StringComparison.OrdinalIgnoreCase));
                _isAuthorized = authorized;
                bool isNowActive = (_isAuthorized && string.Equals(_activeSessionMode, "control", StringComparison.OrdinalIgnoreCase));
                if (wasActive && !isNowActive)
                {
                    ReleaseAllInputs();
                }
            }
        }

        /// <summary>
        /// Resets active session state and releases all pending physical inputs.
        /// </summary>
        public void ResetSession()
        {
            lock (_stateLock)
            {
                ReleaseAllInputs();
                _activeSessionId = null;
                _activeSessionMode = null;
                _isAuthorized = false;
            }
        }

        #endregion

        #region Packet Ingestion & Dispatch

        /// <summary>
        /// Ingests a raw relay packet (Opcode 0x02 or 0x03) and injects into Windows if authorized.
        /// In Observe mode or unauthorized state, strictly ignores and drops the packet.
        /// </summary>
        public bool InjectPacket(byte[] data, int offset, int length)
        {
            if (data == null || length <= 0 || offset < 0 || (offset + length) > data.Length)
            {
                Interlocked.Increment(ref _invalidPacketsCount);
                return false;
            }

            Interlocked.Increment(ref _totalPacketsReceived);

            // STRICT SECURITY GUARD:
            // Input injection is executed ONLY when active session mode == 'control' AND authorization is active.
            // In Observe mode or unauthorized state, all input packets are strictly ignored and dropped.
            if (!IsControlAuthorized)
            {
                Interlocked.Increment(ref _droppedPacketsCount);
                return false;
            }

            byte opcode = data[offset];
            if (opcode == 0x02)
            {
                if (length < 8)
                {
                    Interlocked.Increment(ref _invalidPacketsCount);
                    return false;
                }
                return ProcessMouseEvent(data, offset);
            }
            else if (opcode == 0x03)
            {
                if (length < 5)
                {
                    Interlocked.Increment(ref _invalidPacketsCount);
                    return false;
                }
                return ProcessKeyboardEvent(data, offset);
            }
            else if (opcode == 0x04)
            {
                if (length < 2)
                {
                    Interlocked.Increment(ref _invalidPacketsCount);
                    return false;
                }
                return ProcessTextEvent(data, offset, length);
            }
            else
            {
                Interlocked.Increment(ref _invalidPacketsCount);
                return false;
            }
        }

        private bool ProcessTextEvent(byte[] data, int offset, int length)
        {
            try
            {
                string text = Encoding.UTF8.GetString(data, offset + 1, length - 1);
                if (string.IsNullOrEmpty(text)) return false;

                // Ensure modifier keys are released before typing
                ReleaseModifierIfDown(NativeInput.VK_CONTROL);
                ReleaseModifierIfDown(NativeInput.VK_SHIFT);
                ReleaseModifierIfDown(NativeInput.VK_MENU);
                ReleaseModifierIfDown(NativeInput.VK_LWIN);
                ReleaseModifierIfDown(NativeInput.VK_RWIN);

                foreach (char c in text)
                {
                    if (c == '\r') continue;
                    if (c == '\n')
                    {
                        NativeInput.INPUT enterDown = new NativeInput.INPUT();
                        enterDown.type = NativeInput.INPUT_KEYBOARD;
                        enterDown.u.ki.wVk = 0x0D; // VK_RETURN
                        enterDown.u.ki.dwFlags = 0;

                        NativeInput.INPUT enterUp = enterDown;
                        enterUp.u.ki.dwFlags = NativeInput.KEYEVENTF_KEYUP;

                        NativeInput.SendInput(2, new NativeInput.INPUT[] { enterDown, enterUp }, Marshal.SizeOf(typeof(NativeInput.INPUT)));
                        Interlocked.Increment(ref _totalKeyboardInjected);
                        continue;
                    }

                    NativeInput.INPUT down = new NativeInput.INPUT();
                    down.type = NativeInput.INPUT_KEYBOARD;
                    down.u.ki.wVk = 0;
                    down.u.ki.wScan = (ushort)c;
                    down.u.ki.dwFlags = NativeInput.KEYEVENTF_UNICODE;

                    NativeInput.INPUT up = down;
                    up.u.ki.dwFlags = NativeInput.KEYEVENTF_UNICODE | NativeInput.KEYEVENTF_KEYUP;

                    NativeInput.SendInput(2, new NativeInput.INPUT[] { down, up }, Marshal.SizeOf(typeof(NativeInput.INPUT)));
                    Interlocked.Increment(ref _totalKeyboardInjected);
                }
                return true;
            }
            catch
            {
                return false;
            }
        }

        private bool ProcessMouseEvent(byte[] data, int offset)
        {
            byte eventType = data[offset + 1];
            ushort normX = (ushort)((data[offset + 2] << 8) | data[offset + 3]);
            ushort normY = (ushort)((data[offset + 4] << 8) | data[offset + 5]);
            byte buttons = data[offset + 6];
            sbyte wheelDelta = (sbyte)data[offset + 7];

            NativeInput.INPUT input = new NativeInput.INPUT();
            input.type = NativeInput.INPUT_MOUSE;

            // Multi-Monitor Safe Coordinate Mapping:
            // ScreenCapturer captures the PrimaryScreen bounds.
            // In multi-monitor systems, Windows virtual desktop encompasses all screens.
            // We map normX/normY (0..65535 on PrimaryScreen) into the exact virtual desktop normalized coordinates.
            Rectangle pBounds = Screen.PrimaryScreen.Bounds;
            Rectangle vBounds = SystemInformation.VirtualScreen;

            int targetPixelX = pBounds.Left + (int)Math.Round((double)normX * Math.Max(1, pBounds.Width - 1) / 65535.0);
            int targetPixelY = pBounds.Top + (int)Math.Round((double)normY * Math.Max(1, pBounds.Height - 1) / 65535.0);

            int virtX = (int)Math.Round((double)(targetPixelX - vBounds.Left) * 65535.0 / Math.Max(1, vBounds.Width - 1));
            int virtY = (int)Math.Round((double)(targetPixelY - vBounds.Top) * 65535.0 / Math.Max(1, vBounds.Height - 1));

            input.u.mi.dx = Math.Max(0, Math.Min(65535, virtX));
            input.u.mi.dy = Math.Max(0, Math.Min(65535, virtY));
            input.u.mi.time = 0;
            input.u.mi.dwExtraInfo = UIntPtr.Zero;

            uint flags = NativeInput.MOUSEEVENTF_ABSOLUTE | NativeInput.MOUSEEVENTF_VIRTUALDESK;

            switch (eventType)
            {
                case 0: // Move
                    flags |= NativeInput.MOUSEEVENTF_MOVE;
                    if ((buttons & 0x01) == 0 && _leftButtonDown)
                    {
                        NativeInput.INPUT upInput = input;
                        upInput.u.mi.dwFlags = NativeInput.MOUSEEVENTF_ABSOLUTE | NativeInput.MOUSEEVENTF_VIRTUALDESK | NativeInput.MOUSEEVENTF_LEFTUP;
                        NativeInput.SendInput(1, new NativeInput.INPUT[] { upInput }, Marshal.SizeOf(typeof(NativeInput.INPUT)));
                        _leftButtonDown = false;
                    }
                    if ((buttons & 0x02) == 0 && _rightButtonDown)
                    {
                        NativeInput.INPUT upInput = input;
                        upInput.u.mi.dwFlags = NativeInput.MOUSEEVENTF_ABSOLUTE | NativeInput.MOUSEEVENTF_VIRTUALDESK | NativeInput.MOUSEEVENTF_RIGHTUP;
                        NativeInput.SendInput(1, new NativeInput.INPUT[] { upInput }, Marshal.SizeOf(typeof(NativeInput.INPUT)));
                        _rightButtonDown = false;
                    }
                    break;

                case 1: // Mouse Down
                    flags |= NativeInput.MOUSEEVENTF_MOVE;
                    if ((buttons & 0x01) != 0)
                    {
                        if (_leftButtonDown)
                        {
                            NativeInput.INPUT upInput = input;
                            upInput.u.mi.dwFlags = NativeInput.MOUSEEVENTF_ABSOLUTE | NativeInput.MOUSEEVENTF_VIRTUALDESK | NativeInput.MOUSEEVENTF_LEFTUP;
                            NativeInput.SendInput(1, new NativeInput.INPUT[] { upInput }, Marshal.SizeOf(typeof(NativeInput.INPUT)));
                        }
                        flags |= NativeInput.MOUSEEVENTF_LEFTDOWN;
                        _leftButtonDown = true;
                    }
                    if ((buttons & 0x02) != 0)
                    {
                        flags |= NativeInput.MOUSEEVENTF_RIGHTDOWN;
                        _rightButtonDown = true;
                    }
                    if ((buttons & 0x04) != 0)
                    {
                        flags |= NativeInput.MOUSEEVENTF_MIDDLEDOWN;
                        _middleButtonDown = true;
                    }
                    break;

                case 2: // Mouse Up
                    flags |= NativeInput.MOUSEEVENTF_MOVE;
                    if ((buttons & 0x01) != 0 || _leftButtonDown)
                    {
                        flags |= NativeInput.MOUSEEVENTF_LEFTUP;
                        _leftButtonDown = false;
                    }
                    if ((buttons & 0x02) != 0 || _rightButtonDown)
                    {
                        flags |= NativeInput.MOUSEEVENTF_RIGHTUP;
                        _rightButtonDown = false;
                    }
                    if ((buttons & 0x04) != 0 || _middleButtonDown)
                    {
                        flags |= NativeInput.MOUSEEVENTF_MIDDLEUP;
                        _middleButtonDown = false;
                    }
                    break;

                case 3: // Wheel
                    flags |= NativeInput.MOUSEEVENTF_MOVE | NativeInput.MOUSEEVENTF_WHEEL;
                    int ticks = (int)wheelDelta;
                    int winDelta = (Math.Abs(ticks) < 10) ? (ticks * 120) : ticks;
                    input.u.mi.mouseData = (uint)winDelta;
                    break;

                default:
                    Interlocked.Increment(ref _invalidPacketsCount);
                    return false;
            }

            input.u.mi.dwFlags = flags;
            NativeInput.INPUT[] inputs = new NativeInput.INPUT[] { input };
            uint sent = NativeInput.SendInput(1, inputs, Marshal.SizeOf(typeof(NativeInput.INPUT)));
            if (sent > 0)
            {
                Interlocked.Increment(ref _totalMouseInjected);
                return true;
            }
            return false;
        }

        private void SyncCapsLock(bool clientCaps)
        {
            // Low-order bit of GetKeyState indicates whether the toggle key is toggled ON (1) or OFF (0)
            bool remoteCaps = (NativeInput.GetKeyState(0x14) & 1) != 0; // VK_CAPITAL = 0x14
            if (clientCaps != remoteCaps)
            {
                NativeInput.INPUT[] toggle = new NativeInput.INPUT[2];
                toggle[0].type = NativeInput.INPUT_KEYBOARD;
                toggle[0].u.ki.wVk = 0x14; // VK_CAPITAL
                toggle[0].u.ki.wScan = (ushort)NativeInput.MapVirtualKey(0x14, NativeInput.MAPVK_VK_TO_VSC);
                toggle[0].u.ki.dwFlags = 0; // KeyDown

                toggle[1].type = NativeInput.INPUT_KEYBOARD;
                toggle[1].u.ki.wVk = 0x14;
                toggle[1].u.ki.wScan = toggle[0].u.ki.wScan;
                toggle[1].u.ki.dwFlags = NativeInput.KEYEVENTF_KEYUP; // KeyUp

                NativeInput.SendInput(2, toggle, Marshal.SizeOf(typeof(NativeInput.INPUT)));
            }
        }

        private bool ProcessKeyboardEvent(byte[] data, int offset)
        {
            byte eventType = data[offset + 1];
            ushort vkCode = (ushort)((data[offset + 2] << 8) | data[offset + 3]);
            byte modifiers = data[offset + 4];

            bool isKeyUp = (eventType == 1);
            bool clientCaps = (modifiers & 0x10) != 0;

            // Handle direct CapsLock key press
            if (vkCode == 0x14)
            {
                if (!isKeyUp)
                {
                    SyncCapsLock(clientCaps);
                }
                return true;
            }

            // For all other key presses, ensure remote CapsLock matches client CapsLock
            if (!isKeyUp)
            {
                SyncCapsLock(clientCaps);
            }

            NativeInput.INPUT input = new NativeInput.INPUT();
            input.type = NativeInput.INPUT_KEYBOARD;
            input.u.ki.wVk = vkCode;
            input.u.ki.wScan = (ushort)NativeInput.MapVirtualKey((uint)vkCode, NativeInput.MAPVK_VK_TO_VSC);
            input.u.ki.time = 0;
            input.u.ki.dwExtraInfo = UIntPtr.Zero;

            uint flags = 0;
            if (isKeyUp)
            {
                flags |= NativeInput.KEYEVENTF_KEYUP;
                lock (_keysLock)
                {
                    _pressedKeys.Remove(vkCode);
                }
            }
            else
            {
                lock (_keysLock)
                {
                    _pressedKeys.Add(vkCode);
                }
            }

            if (IsExtendedKey(vkCode))
            {
                flags |= NativeInput.KEYEVENTF_EXTENDEDKEY;
            }

            input.u.ki.dwFlags = flags;
            NativeInput.INPUT[] inputs = new NativeInput.INPUT[] { input };
            uint sent = NativeInput.SendInput(1, inputs, Marshal.SizeOf(typeof(NativeInput.INPUT)));
            if (sent > 0)
            {
                Interlocked.Increment(ref _totalKeyboardInjected);
                return true;
            }
            return false;
        }

        #endregion

        #region Ghost Input / Stuck Key Immunity

        /// <summary>
        /// Releases all tracked mouse buttons, keyboard keys, and system modifiers.
        /// </summary>
        public void ReleaseAllInputs()
        {
            // 1. Release Mouse Buttons if currently depressed
            if (_leftButtonDown || _rightButtonDown || _middleButtonDown)
            {
                NativeInput.INPUT mi = new NativeInput.INPUT();
                mi.type = NativeInput.INPUT_MOUSE;
                uint mFlags = 0;
                if (_leftButtonDown) { mFlags |= NativeInput.MOUSEEVENTF_LEFTUP; _leftButtonDown = false; }
                if (_rightButtonDown) { mFlags |= NativeInput.MOUSEEVENTF_RIGHTUP; _rightButtonDown = false; }
                if (_middleButtonDown) { mFlags |= NativeInput.MOUSEEVENTF_MIDDLEUP; _middleButtonDown = false; }
                mi.u.mi.dwFlags = mFlags;
                NativeInput.SendInput(1, new NativeInput.INPUT[] { mi }, Marshal.SizeOf(typeof(NativeInput.INPUT)));
            }

            // 2. Release tracked pressed keyboard keys
            List<ushort> keysToRelease;
            lock (_keysLock)
            {
                keysToRelease = new List<ushort>(_pressedKeys);
                _pressedKeys.Clear();
            }

            if (keysToRelease.Count > 0)
            {
                NativeInput.INPUT[] inputs = new NativeInput.INPUT[keysToRelease.Count];
                for (int i = 0; i < keysToRelease.Count; i++)
                {
                    ushort vk = keysToRelease[i];
                    inputs[i].type = NativeInput.INPUT_KEYBOARD;
                    inputs[i].u.ki.wVk = vk;
                    inputs[i].u.ki.wScan = (ushort)NativeInput.MapVirtualKey((uint)vk, NativeInput.MAPVK_VK_TO_VSC);
                    uint kFlags = NativeInput.KEYEVENTF_KEYUP;
                    if (IsExtendedKey(vk)) kFlags |= NativeInput.KEYEVENTF_EXTENDEDKEY;
                    inputs[i].u.ki.dwFlags = kFlags;
                }
                NativeInput.SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(NativeInput.INPUT)));
            }

            // 3. Release modifier keys if held down
            ReleaseModifierIfDown(NativeInput.VK_CONTROL);
            ReleaseModifierIfDown(NativeInput.VK_SHIFT);
            ReleaseModifierIfDown(NativeInput.VK_MENU);
            ReleaseModifierIfDown(NativeInput.VK_LWIN);
            ReleaseModifierIfDown(NativeInput.VK_RWIN);
        }

        private static void ReleaseModifierIfDown(int vk)
        {
            NativeInput.INPUT input = new NativeInput.INPUT();
            input.type = NativeInput.INPUT_KEYBOARD;
            input.u.ki.wVk = (ushort)vk;
            input.u.ki.wScan = (ushort)NativeInput.MapVirtualKey((uint)vk, NativeInput.MAPVK_VK_TO_VSC);
            uint flags = NativeInput.KEYEVENTF_KEYUP;
            if (IsExtendedKey((ushort)vk)) flags |= NativeInput.KEYEVENTF_EXTENDEDKEY;
            input.u.ki.dwFlags = flags;
            NativeInput.SendInput(1, new NativeInput.INPUT[] { input }, Marshal.SizeOf(typeof(NativeInput.INPUT)));
        }

        private static bool IsExtendedKey(ushort vkCode)
        {
            switch (vkCode)
            {
                case 0x21: // Page Up (PRIOR)
                case 0x22: // Page Down (NEXT)
                case 0x23: // End
                case 0x24: // Home
                case 0x25: // Left
                case 0x26: // Up
                case 0x27: // Right
                case 0x28: // Down
                case 0x2D: // Insert
                case 0x2E: // Delete
                case 0x5B: // LWIN
                case 0x5C: // RWIN
                case 0x5D: // APPS
                case 0x6F: // Divide (Numpad /)
                case 0x90: // Num Lock
                case 0xA3: // RCONTROL
                case 0xA5: // RMENU (Right Alt / AltGr)
                    return true;
                default:
                    return false;
            }
        }

        #endregion
    }
}
