// ============================================================================
// VisionDesk - High-Performance Windows Desktop Capture Engine
// File: agent/ScreenCapturer.cs
//
// Features:
// - Win32 GDI BitBlt capture with SRCCOPY | CAPTUREBLT
// - Hardware/Software cursor rendering with hotspot alignment
// - Leak-free GDI handle cleanup (Deletes hbmMask/hbmColor on every frame)
// - High-speed Bilinear downscaling (proportional aspect ratio)
// - GDI+ JPEG compression with Quality 70
// - Reusable memory buffers and strict disposal of GDI bitmaps/DCs
// - Dual-mode cadence: 5s base64 JSON thumbnail vs 15 FPS binary streaming (0x01 + JPEG)
// - 100% C# 5 syntax compatible for native csc.exe compilation
// ============================================================================

using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Net.WebSockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace VisionDesk.Agent
{
    /// <summary>
    /// Configuration options for the screen capture engine.
    /// </summary>
    public class ScreenCapturerConfig
    {
        public int ThumbnailWidth { get; set; }
        public long ThumbnailQuality { get; set; }
        public int ThumbnailIntervalMs { get; set; }

        public int StreamWidth { get; set; }
        public int StreamFps { get; set; }
        public long StreamQuality { get; set; }

        public bool IncludeCursor { get; set; }
        public bool PauseThumbnailDuringStream { get; set; }

        public ScreenCapturerConfig()
        {
            ThumbnailWidth = 480;
            ThumbnailQuality = 70L;
            ThumbnailIntervalMs = 5000;

            StreamWidth = 1280;
            StreamFps = 15;
            StreamQuality = 75L;

            IncludeCursor = true;
            PauseThumbnailDuringStream = false;
        }
    }

    /// <summary>
    /// High-performance desktop capturer and dual-mode streaming orchestrator.
    /// </summary>
    public class ScreenCapturer : IDisposable
    {
        #region Win32 P/Invoke Definitions

        [StructLayout(LayoutKind.Sequential)]
        public struct POINT
        {
            public int x;
            public int y;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct CURSORINFO
        {
            public int cbSize;
            public int flags;
            public IntPtr hCursor;
            public POINT ptScreenPos;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct ICONINFO
        {
            public bool fIcon;
            public int xHotspot;
            public int yHotspot;
            public IntPtr hbmMask;
            public IntPtr hbmColor;
        }

        private const int SRCCOPY = 0x00CC0020;
        private const int CAPTUREBLT = 0x40000000;
        private const int ROP_CAPTURE = SRCCOPY | CAPTUREBLT;

        private const int CURSOR_SHOWING = 0x00000001;
        private const int DI_NORMAL = 0x0003;

        [DllImport("user32.dll", SetLastError = true)]
        private static extern IntPtr GetDC(IntPtr hWnd);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool GetCursorInfo(out CURSORINFO pci);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool GetIconInfo(IntPtr hIcon, out ICONINFO piconinfo);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool DrawIconEx(IntPtr hdc, int xLeft, int yTop, IntPtr hIcon, int cxWidth, int cyHeight, int istepIfAniCur, IntPtr hbrFlickerFreeDraw, int diFlags);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern IntPtr LoadCursor(IntPtr hInstance, int lpCursorName);

        [DllImport("gdi32.dll", SetLastError = true)]
        private static extern bool BitBlt(IntPtr hdcDest, int nXDest, int nYDest, int nWidth, int nHeight, IntPtr hdcSrc, int nXSrc, int nYSrc, int dwRop);

        private const int HALFTONE = 4;

        [DllImport("gdi32.dll", SetLastError = true)]
        private static extern bool StretchBlt(IntPtr hdcDest, int nXDest, int nYDest, int nWidthDest, int nHeightDest, IntPtr hdcSrc, int nXSrc, int nYSrc, int nWidthSrc, int nHeightSrc, int dwRop);

        [DllImport("gdi32.dll", SetLastError = true)]
        private static extern int SetStretchBltMode(IntPtr hdc, int iStretchMode);

        [DllImport("gdi32.dll", SetLastError = true)]
        private static extern bool SetBrushOrgEx(IntPtr hdc, int nXOrg, int nYOrg, IntPtr lppt);

        [DllImport("gdi32.dll", SetLastError = true)]
        private static extern bool DeleteObject(IntPtr hObject);

        #endregion

        #region Private Fields & Buffers

        private readonly ScreenCapturerConfig _config;
        private readonly object _captureLock = new object();
        private readonly ImageCodecInfo _jpegEncoder;
        private readonly EncoderParameters _thumbEncoderParams;
        private readonly EncoderParameters _streamEncoderParams;

        // Reusable Desktop Capture Resources
        private int _currentScreenWidth;
        private int _currentScreenHeight;
        private Bitmap _screenBitmap;
        private Graphics _screenGraphics;

        // Reusable Thumbnail Resources
        private Bitmap _thumbBitmap;
        private Graphics _thumbGraphics;
        private readonly MemoryStream _thumbStream;

        // Reusable Streaming Resources
        private Bitmap _streamBitmap;
        private Graphics _streamGraphics;
        private readonly MemoryStream _streamStream;

        // Operational State
        private volatile bool _isDisposed;
        private volatile bool _isStreamingActive;
        private volatile string _streamMode = "control";
        private CancellationTokenSource _streamCts;
        private IntPtr _lastReportedCursor = IntPtr.Zero;
        private string _lastReportedShape = "default";
        private static readonly System.Collections.Generic.Dictionary<IntPtr, string> _systemCursorMap = new System.Collections.Generic.Dictionary<IntPtr, string>();

        // Callbacks
        public Action<byte[], int> OnInputPacketReceived;
        public Action<string> OnLogMessage;

        public readonly FrameGate Gate = new FrameGate();

        #endregion

        #region Constructor & Initialization

        static ScreenCapturer()
        {
            InitSystemCursors();
        }

        private static void InitSystemCursors()
        {
            try
            {
                _systemCursorMap[LoadCursor(IntPtr.Zero, 32512)] = "default";
                _systemCursorMap[LoadCursor(IntPtr.Zero, 32513)] = "text";
                _systemCursorMap[LoadCursor(IntPtr.Zero, 32514)] = "wait";
                _systemCursorMap[LoadCursor(IntPtr.Zero, 32515)] = "crosshair";
                _systemCursorMap[LoadCursor(IntPtr.Zero, 32649)] = "pointer";
                _systemCursorMap[LoadCursor(IntPtr.Zero, 32645)] = "ns-resize";
                _systemCursorMap[LoadCursor(IntPtr.Zero, 32644)] = "ew-resize";
                _systemCursorMap[LoadCursor(IntPtr.Zero, 32646)] = "move";
                _systemCursorMap[LoadCursor(IntPtr.Zero, 32648)] = "not-allowed";
                _systemCursorMap[LoadCursor(IntPtr.Zero, 32642)] = "nwse-resize";
                _systemCursorMap[LoadCursor(IntPtr.Zero, 32643)] = "nesw-resize";
                _systemCursorMap[LoadCursor(IntPtr.Zero, 32650)] = "progress";
            }
            catch { }
        }

        private static string DetectCursorShape(IntPtr hCursor)
        {
            if (hCursor == IntPtr.Zero) return "default";
            string shape;
            if (_systemCursorMap.TryGetValue(hCursor, out shape))
            {
                return shape;
            }

            try
            {
                ICONINFO ii;
                if (GetIconInfo(hCursor, out ii))
                {
                    try
                    {
                        if (ii.xHotspot == 0 && ii.yHotspot == 0) return "default";
                        if (ii.xHotspot > 0 && ii.yHotspot == 0) return "pointer";
                        if (ii.xHotspot >= 3 && ii.xHotspot <= 8 && ii.yHotspot >= 7) return "text";
                        if (ii.xHotspot >= 10 && ii.yHotspot >= 10) return "move";
                    }
                    finally
                    {
                        if (ii.hbmMask != IntPtr.Zero) DeleteObject(ii.hbmMask);
                        if (ii.hbmColor != IntPtr.Zero) DeleteObject(ii.hbmColor);
                    }
                }
            }
            catch { }

            return "default";
        }

        public ScreenCapturer(ScreenCapturerConfig config)
        {
            if (config == null) throw new ArgumentNullException("config");
            _config = config;

            // 1. Locate Native GDI+ JPEG Encoder
            _jpegEncoder = GetJpegEncoder();
            if (_jpegEncoder == null)
            {
                throw new InvalidOperationException("GDI+ JPEG encoder not found in runtime environment.");
            }

            // 2. Pre-configure Encoder Quality Parameters (Quality 70)
            _thumbEncoderParams = new EncoderParameters(1);
            _thumbEncoderParams.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, _config.ThumbnailQuality);

            _streamEncoderParams = new EncoderParameters(1);
            _streamEncoderParams.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, _config.StreamQuality);

            // 3. Pre-allocate Memory Streams with sensible initial capacity
            _thumbStream = new MemoryStream(64 * 1024);
            _streamStream = new MemoryStream(128 * 1024);

            // 4. Initialize Capture Buffers
            ReinitializeBuffers();
        }

        private static ImageCodecInfo GetJpegEncoder()
        {
            ImageCodecInfo[] codecs = ImageCodecInfo.GetImageEncoders();
            for (int i = 0; i < codecs.Length; i++)
            {
                if (codecs[i].FormatID == ImageFormat.Jpeg.Guid)
                    return codecs[i];
            }
            return null;
        }

        private void ReinitializeBuffers()
        {
            lock (_captureLock)
            {
                Rectangle bounds = Screen.PrimaryScreen.Bounds;
                _currentScreenWidth = bounds.Width;
                _currentScreenHeight = bounds.Height;

                // Dispose old thumbnail resources if present
                if (_thumbGraphics != null) { _thumbGraphics.Dispose(); _thumbGraphics = null; }
                if (_thumbBitmap != null) { _thumbBitmap.Dispose(); _thumbBitmap = null; }

                // Allocate Thumbnail Buffer (480x270 for 16:9, ~388 KB)
                Size thumbSize = CalculateScaledDimensions(_currentScreenWidth, _currentScreenHeight, _config.ThumbnailWidth);
                _thumbBitmap = new Bitmap(thumbSize.Width, thumbSize.Height, PixelFormat.Format24bppRgb);
                _thumbGraphics = Graphics.FromImage(_thumbBitmap);
                ConfigureHighSpeedGraphics(_thumbGraphics);

                // Dispose full desktop and streaming buffers to keep idle memory minimal
                DisposeStreamingBuffers();
            }
        }

        private void EnsureStreamingBuffers()
        {
            lock (_captureLock)
            {
                if (_screenBitmap == null)
                {
                    _screenBitmap = new Bitmap(_currentScreenWidth, _currentScreenHeight, PixelFormat.Format24bppRgb);
                    _screenGraphics = Graphics.FromImage(_screenBitmap);
                }

                if (_streamBitmap == null)
                {
                    Size streamSize = CalculateScaledDimensions(_currentScreenWidth, _currentScreenHeight, _config.StreamWidth);
                    _streamBitmap = new Bitmap(streamSize.Width, streamSize.Height, PixelFormat.Format24bppRgb);
                    _streamGraphics = Graphics.FromImage(_streamBitmap);
                    ConfigureHighSpeedGraphics(_streamGraphics);
                }
            }
        }

        private void DisposeStreamingBuffers()
        {
            lock (_captureLock)
            {
                if (_screenGraphics != null) { _screenGraphics.Dispose(); _screenGraphics = null; }
                if (_screenBitmap != null) { _screenBitmap.Dispose(); _screenBitmap = null; }
                if (_streamGraphics != null) { _streamGraphics.Dispose(); _streamGraphics = null; }
                if (_streamBitmap != null) { _streamBitmap.Dispose(); _streamBitmap = null; }
            }
        }

        private static void ConfigureHighSpeedGraphics(Graphics g)
        {
            g.InterpolationMode = InterpolationMode.Bilinear;
            g.SmoothingMode = SmoothingMode.HighSpeed;
            g.PixelOffsetMode = PixelOffsetMode.HighSpeed;
            g.CompositingQuality = CompositingQuality.HighSpeed;
        }

        public static Size CalculateScaledDimensions(int srcWidth, int srcHeight, int targetWidth)
        {
            if (srcWidth <= 0 || srcHeight <= 0) return new Size(targetWidth, (int)(targetWidth * 9.0 / 16.0));
            int targetHeight = (int)Math.Round((double)srcHeight * targetWidth / srcWidth);
            if (targetHeight % 2 != 0) targetHeight++; // Keep height even
            return new Size(targetWidth, targetHeight);
        }

        #endregion

        #region Core Capture & Cursor Mechanics

        /// <summary>
        /// Captures the primary screen into the internal buffer, rendering the mouse cursor.
        /// Must be called inside _captureLock.
        /// </summary>
        private void CaptureDesktopInternal()
        {
            Rectangle bounds = Screen.PrimaryScreen.Bounds;
            if (bounds.Width != _currentScreenWidth || bounds.Height != _currentScreenHeight)
            {
                ReinitializeBuffers();
                EnsureStreamingBuffers();
            }
            else
            {
                EnsureStreamingBuffers();
            }

            IntPtr hdcDest = _screenGraphics.GetHdc();
            IntPtr hdcSrc = GetDC(IntPtr.Zero);
            try
            {
                BitBlt(hdcDest, 0, 0, _currentScreenWidth, _currentScreenHeight, hdcSrc, bounds.Left, bounds.Top, ROP_CAPTURE);
                // Truco #1: Client-Side Cursor (Cursor Local Inmediato)
                // En modo interactivo de Control, el cliente renderiza su propio cursor a 0 ms.
                // Solo se quema el cursor en la imagen durante la auditoría pasiva (modo 'observe')
                // o cuando no hay streaming activo (miniaturas de supervisión).
                bool shouldBurnCursor = _config.IncludeCursor && (!_isStreamingActive || _streamMode == "observe");
                if (shouldBurnCursor)
                {
                    DrawCursorInternal(hdcDest, bounds.Left, bounds.Top);
                }
            }
            finally
            {
                ReleaseDC(IntPtr.Zero, hdcSrc);
                _screenGraphics.ReleaseHdc(hdcDest);
            }
        }

        /// <summary>
        /// Renders the mouse cursor onto the target HDC with hotspot correction and leak-free handle cleanup.
        /// </summary>
        private static void DrawCursorInternal(IntPtr hdc, int screenLeft, int screenTop)
        {
            CURSORINFO ci = new CURSORINFO();
            ci.cbSize = Marshal.SizeOf(typeof(CURSORINFO));
            if (GetCursorInfo(out ci))
            {
                if (ci.flags == CURSOR_SHOWING && ci.hCursor != IntPtr.Zero)
                {
                    ICONINFO ii;
                    if (GetIconInfo(ci.hCursor, out ii))
                    {
                        try
                        {
                            int drawX = (ci.ptScreenPos.x - screenLeft) - ii.xHotspot;
                            int drawY = (ci.ptScreenPos.y - screenTop) - ii.yHotspot;
                            DrawIconEx(hdc, drawX, drawY, ci.hCursor, 0, 0, 0, IntPtr.Zero, DI_NORMAL);
                        }
                        finally
                        {
                            // CRITICAL: DeleteObject MUST be called on both bitmaps created by GetIconInfo to prevent handle leaks!
                            if (ii.hbmMask != IntPtr.Zero) DeleteObject(ii.hbmMask);
                            if (ii.hbmColor != IntPtr.Zero) DeleteObject(ii.hbmColor);
                        }
                    }
                }
            }
        }

        #endregion

        #region Mode 1: 5-Second Thumbnail Mode (Base64 JSON)

        /// <summary>
        /// Captures screen directly to thumbnail size via Win32 StretchBlt with halftone downscaling,
        /// bypassing the 6.22 MB intermediate 1080p full-screen bitmap.
        /// </summary>
        public byte[] CaptureThumbnailJpeg()
        {
            lock (_captureLock)
            {
                if (_isDisposed) return null;

                Rectangle bounds = Screen.PrimaryScreen.Bounds;
                if (bounds.Width != _currentScreenWidth || bounds.Height != _currentScreenHeight)
                {
                    ReinitializeBuffers();
                }

                IntPtr hdcDest = _thumbGraphics.GetHdc();
                IntPtr hdcSrc = GetDC(IntPtr.Zero);
                try
                {
                    SetStretchBltMode(hdcDest, HALFTONE);
                    SetBrushOrgEx(hdcDest, 0, 0, IntPtr.Zero);
                    StretchBlt(hdcDest, 0, 0, _thumbBitmap.Width, _thumbBitmap.Height,
                               hdcSrc, bounds.Left, bounds.Top, _currentScreenWidth, _currentScreenHeight,
                               ROP_CAPTURE);

                    if (_config.IncludeCursor)
                    {
                        DrawCursorScaledInternal(hdcDest, bounds.Left, bounds.Top,
                            (float)_thumbBitmap.Width / _currentScreenWidth,
                            (float)_thumbBitmap.Height / _currentScreenHeight);
                    }
                }
                finally
                {
                    ReleaseDC(IntPtr.Zero, hdcSrc);
                    _thumbGraphics.ReleaseHdc(hdcDest);
                }

                _thumbStream.SetLength(0);
                _thumbStream.Position = 0;
                _thumbBitmap.Save(_thumbStream, _jpegEncoder, _thumbEncoderParams);

                return _thumbStream.ToArray();
            }
        }

        private static void DrawCursorScaledInternal(IntPtr hdc, int screenLeft, int screenTop, float scaleX, float scaleY)
        {
            CURSORINFO ci = new CURSORINFO();
            ci.cbSize = Marshal.SizeOf(typeof(CURSORINFO));
            if (GetCursorInfo(out ci))
            {
                if (ci.flags == CURSOR_SHOWING && ci.hCursor != IntPtr.Zero)
                {
                    ICONINFO ii;
                    if (GetIconInfo(ci.hCursor, out ii))
                    {
                        try
                        {
                            int drawX = (int)((ci.ptScreenPos.x - screenLeft) * scaleX) - (int)(ii.xHotspot * scaleX);
                            int drawY = (int)((ci.ptScreenPos.y - screenTop) * scaleY) - (int)(ii.yHotspot * scaleY);
                            int iconWidth = Math.Max(1, (int)(32 * scaleX));
                            int iconHeight = Math.Max(1, (int)(32 * scaleY));
                            DrawIconEx(hdc, drawX, drawY, ci.hCursor, iconWidth, iconHeight, 0, IntPtr.Zero, DI_NORMAL);
                        }
                        finally
                        {
                            if (ii.hbmMask != IntPtr.Zero) DeleteObject(ii.hbmMask);
                            if (ii.hbmColor != IntPtr.Zero) DeleteObject(ii.hbmColor);
                        }
                    }
                }
            }
        }

        /// <summary>
        /// Captures screen and returns a Base64-encoded JPEG string ready for branch:thumbnail payload.
        /// </summary>
        public string CaptureThumbnailBase64()
        {
            byte[] jpegBytes = CaptureThumbnailJpeg();
            if (jpegBytes == null || jpegBytes.Length == 0) return string.Empty;
            return Convert.ToBase64String(jpegBytes);
        }

        /// <summary>
        /// Starts the background thumbnail transmission loop sending base64 JSON every 5s.
        /// </summary>
        public async Task RunThumbnailLoopAsync(
            Func<string, Task> sendSignalingMessageAsync,
            string branchId,
            CancellationToken ct)
        {
            if (sendSignalingMessageAsync == null) throw new ArgumentNullException("sendSignalingMessageAsync");

            Random rnd = new Random();
            Log(string.Format("Thumbnail capture loop initialized (interval: {0} ms).", _config.ThumbnailIntervalMs));

            while (!ct.IsCancellationRequested && !_isDisposed)
            {
                bool hadError = false;
                try
                {
                    // Check if paused during active live streaming
                    if (_config.PauseThumbnailDuringStream && _isStreamingActive)
                    {
                        await Task.Delay(1000, ct);
                        continue;
                    }

                    string base64Data = CaptureThumbnailBase64();
                    if (!string.IsNullOrEmpty(base64Data))
                    {
                        long timestamp = (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
                        string jsonPayload = string.Format(
                            "{{\"type\":\"branch:thumbnail\",\"payload\":{{\"branchId\":\"{0}\",\"format\":\"jpeg\",\"timestamp\":{1},\"data\":\"{2}\"}}}}",
                            (branchId ?? "").ToLowerInvariant(), timestamp, base64Data);

                        await sendSignalingMessageAsync(jsonPayload);
                    }

                    // Interval with +/- 150 ms jitter to prevent thundering herd across branches
                    int jitter = rnd.Next(-150, 150);
                    int delay = Math.Max(1000, _config.ThumbnailIntervalMs + jitter);
                    await Task.Delay(delay, ct);
                }
                catch (OperationCanceledException)
                {
                    break;
                }
                catch (Exception ex)
                {
                    Log(string.Format("Thumbnail capture exception: {0}", ex.Message));
                    hadError = true;
                }

                if (hadError)
                {
                    try
                    {
                        await Task.Delay(3000, ct);
                    }
                    catch (OperationCanceledException)
                    {
                        break;
                    }
                }
            }

            Log("Thumbnail capture loop stopped.");
        }

        #endregion

        #region Mode 2: 15 FPS Live Streaming Mode (Binary 0x01 + JPEG)

        /// <summary>
        /// Starts high-performance 15 FPS screen streaming directly over WebRTC DataChannel (Tier 1 P2P / Tier 2 TURN).
        /// </summary>
        public async Task StartWebRtcStreamingAsync(
            WebRtcManager rtc,
            string mode,
            CancellationToken ct)
        {
            if (rtc == null) throw new ArgumentNullException("rtc");

            StopLiveStreaming();
            EnsureStreamingBuffers();

            _streamCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            CancellationToken tokenToUse = _streamCts.Token;

            _isStreamingActive = true;
            Gate.Reset();
            Gate.MaxInFlight = 1;
            _streamMode = !string.IsNullOrEmpty(mode) ? mode.ToLowerInvariant() : "control";
            _lastReportedCursor = IntPtr.Zero;
            _lastReportedShape = "default";

            Log("Commencing 15 FPS WebRTC direct DataChannel streaming pipeline...");

            EncoderParameters params75 = new EncoderParameters(1);
            params75.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 75L);
            EncoderParameters params65 = new EncoderParameters(1);
            params65.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 65L);
            EncoderParameters params55 = new EncoderParameters(1);
            params55.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 55L);

            try
            {
                System.Diagnostics.Stopwatch sw = System.Diagnostics.Stopwatch.StartNew();
                long targetTicksPerFrame = System.Diagnostics.Stopwatch.Frequency / _config.StreamFps;
                long nextFrameTicks = sw.ElapsedTicks;

                while (!tokenToUse.IsCancellationRequested && rtc.IsConnected && !_isDisposed)
                {
                    // Flow-control gate: wait if unacknowledged frame in-flight OR network buffer busy
                    if (!Gate.CanSend() || rtc.VideoBufferedAmount > 32768)
                    {
                        await Task.Delay(2, tokenToUse);
                        continue;
                    }

                    // Adaptive JPEG compression based on Gate.AckMs EWMA
                    EncoderParameters activeEncoderParams;
                    if (Gate.AckMs > 110)
                    {
                        activeEncoderParams = params55;
                    }
                    else if (Gate.AckMs > 60)
                    {
                        activeEncoderParams = params65;
                    }
                    else
                    {
                        activeEncoderParams = params75;
                    }

                    ArraySegment<byte> frameSegment;
                    lock (_captureLock)
                    {
                        CaptureDesktopInternal();
                        _streamGraphics.DrawImage(_screenBitmap, 0, 0, _streamBitmap.Width, _streamBitmap.Height);

                        _streamStream.SetLength(0);
                        _streamStream.Position = 0;
                        _streamStream.WriteByte(0x01); // Video Opcode

                        _streamBitmap.Save(_streamStream, _jpegEncoder, activeEncoderParams);
                        frameSegment = new ArraySegment<byte>(_streamStream.GetBuffer(), 0, (int)_streamStream.Length);
                    }

                    bool sent = rtc.SendVideoFrame(frameSegment.Array, frameSegment.Offset, frameSegment.Count);
                    if (sent)
                    {
                        Gate.OnSent();
                    }

                    // Client-Side Cursor (Truco #1): Detect remote cursor shape and notify controller
                    if (_streamMode == "control")
                    {
                        try
                        {
                            CURSORINFO ci = new CURSORINFO();
                            ci.cbSize = Marshal.SizeOf(typeof(CURSORINFO));
                            if (GetCursorInfo(out ci))
                            {
                                if (ci.flags == CURSOR_SHOWING && ci.hCursor != IntPtr.Zero && ci.hCursor != _lastReportedCursor)
                                {
                                    _lastReportedCursor = ci.hCursor;
                                    string shape = DetectCursorShape(ci.hCursor);
                                    if (shape != _lastReportedShape)
                                    {
                                        _lastReportedShape = shape;
                                        string shapeJson = string.Format("{{\"type\":\"cursor:shape\",\"shape\":\"{0}\"}}", shape);
                                        rtc.SendControlMessage(shapeJson);
                                    }
                                }
                            }
                        }
                        catch { }
                    }

                    nextFrameTicks += targetTicksPerFrame;
                    long waitTicks = nextFrameTicks - sw.ElapsedTicks;
                    if (waitTicks > 0)
                    {
                        int waitMs = (int)(waitTicks * 1000 / System.Diagnostics.Stopwatch.Frequency);
                        if (waitMs > 0) await Task.Delay(waitMs, tokenToUse);
                    }
                    else
                    {
                        nextFrameTicks = sw.ElapsedTicks;
                        await Task.Yield();
                    }
                }
            }
            catch (OperationCanceledException) { }
            catch (Exception ex)
            {
                if (!tokenToUse.IsCancellationRequested)
                {
                    Log(string.Format("WebRTC stream loop error: {0}", ex.Message));
                }
            }
            finally
            {
                if (params75 != null) { try { params75.Dispose(); } catch { } }
                if (params65 != null) { try { params65.Dispose(); } catch { } }
                if (params55 != null) { try { params55.Dispose(); } catch { } }
                _isStreamingActive = false;
                DisposeStreamingBuffers();
                Log("WebRTC streaming loop finished.");
            }
        }

        /// <summary>
        /// Starts high-performance 15 FPS screen streaming to /ws/relay.
        /// </summary>
        public async Task StartLiveStreamingAsync(
            string relayWsUrl,
            string sessionId,
            string mode,
            string token,
            CancellationToken ct)
        {
            if (string.IsNullOrEmpty(relayWsUrl)) throw new ArgumentNullException("relayWsUrl");
            if (string.IsNullOrEmpty(sessionId)) throw new ArgumentNullException("sessionId");

            // Stop any currently running stream
            StopLiveStreaming();

            // Allocate streaming buffers lazily
            EnsureStreamingBuffers();

            _streamCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            CancellationToken tokenToUse = _streamCts.Token;
            _isStreamingActive = true;
            Gate.Reset();
            _streamMode = !string.IsNullOrEmpty(mode) ? mode.ToLowerInvariant() : "control";
            _lastReportedCursor = IntPtr.Zero;
            _lastReportedShape = "default";

            // Formulate full relay URI with query parameters
            string delimiter = relayWsUrl.Contains("?") ? "&" : "?";
            string fullUrl = string.Format(
                "{0}{1}sessionId={2}&role=agent&token={3}&mode={4}",
                relayWsUrl,
                delimiter,
                Uri.EscapeDataString(sessionId),
                Uri.EscapeDataString(token != null ? token : string.Empty),
                Uri.EscapeDataString(mode != null ? mode : "control"));

            Log(string.Format("Connecting to Relay Broker at: {0} (Session: {1}, Mode: {2})", relayWsUrl, sessionId, mode));

            ClientWebSocket ws = new ClientWebSocket();
            try
            {
                await ws.ConnectAsync(new Uri(fullUrl), tokenToUse);
                Log("Connected to Relay Broker successfully. Commencing 15 FPS video pipeline...");

                // Run concurrent duplex loops: Send video frames & Receive remote inputs/status
                Task sendTask = RunStreamSendLoopAsync(ws, tokenToUse);
                Task recvTask = RunStreamReceiveLoopAsync(ws, tokenToUse);

                await Task.WhenAny(sendTask, recvTask);

                if (ws.State == WebSocketState.Open || ws.State == WebSocketState.CloseReceived)
                {
                    try
                    {
                        await ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "Session ended", CancellationToken.None);
                    }
                    catch { }
                }
            }
            catch (Exception ex)
            {
                if (!tokenToUse.IsCancellationRequested)
                {
                    Log(string.Format("Relay session error: {0}", ex.Message));
                }
            }
            finally
            {
                _isStreamingActive = false;
                try
                {
                    if (ws.State == WebSocketState.Open || ws.State == WebSocketState.CloseReceived)
                    {
                        ws.Abort();
                    }
                }
                catch { }
                ws.Dispose();
                DisposeStreamingBuffers();
                Log("Live streaming session teardown complete. Resumed passive monitoring.");
            }
        }

        /// <summary>
        /// Terminates the active live streaming session and signals loop cancellation.
        /// </summary>
        public void StopLiveStreaming()
        {
            lock (_captureLock)
            {
                _isStreamingActive = false;
                _streamMode = "control";
                _lastReportedCursor = IntPtr.Zero;
                _lastReportedShape = "default";
                if (_streamCts != null)
                {
                    try { _streamCts.Cancel(); } catch { }
                    _streamCts.Dispose();
                    _streamCts = null;
                }
                DisposeStreamingBuffers();
            }
            Log("Live streaming stopped and streaming buffers disposed.");
        }

        /// <summary>
        /// Core 15 FPS Video Capture and Binary Transmission Loop.
        /// </summary>
        private async Task RunStreamSendLoopAsync(ClientWebSocket ws, CancellationToken ct)
        {
            System.Diagnostics.Stopwatch sw = System.Diagnostics.Stopwatch.StartNew();
            long targetTicksPerFrame = System.Diagnostics.Stopwatch.Frequency / _config.StreamFps;
            long nextFrameTicks = sw.ElapsedTicks;

            while (!ct.IsCancellationRequested && ws.State == WebSocketState.Open && !_isDisposed)
            {
                try
                {
                    // Flow-control gate: wait if too many unacknowledged frames
                    if (!Gate.CanSend()) { await Task.Delay(3, ct); continue; }

                    ArraySegment<byte> frameSegment;
                    lock (_captureLock)
                    {
                        CaptureDesktopInternal();

                        // Downscale to stream buffer (640x360 for 16:9)
                        _streamGraphics.DrawImage(_screenBitmap, 0, 0, _streamBitmap.Width, _streamBitmap.Height);

                        // Prepare reusable stream: Write Byte 0 = 0x01 (Video Opcode)
                        _streamStream.SetLength(0);
                        _streamStream.Position = 0;
                        _streamStream.WriteByte(0x01);

                        // Save JPEG payload directly starting at offset 1 (Zero-Copy)
                        _streamBitmap.Save(_streamStream, _jpegEncoder, _streamEncoderParams);

                        frameSegment = new ArraySegment<byte>(_streamStream.GetBuffer(), 0, (int)_streamStream.Length);
                    }

                    // Transmit binary video frame to relay broker
                    await ws.SendAsync(frameSegment, WebSocketMessageType.Binary, true, ct);
                    Gate.OnSent();

                    // Client-Side Cursor (Truco #1): Detect remote cursor shape and notify controller
                    if (_streamMode == "control")
                    {
                        try
                        {
                            CURSORINFO ci = new CURSORINFO();
                            ci.cbSize = Marshal.SizeOf(typeof(CURSORINFO));
                            if (GetCursorInfo(out ci))
                            {
                                if (ci.flags == CURSOR_SHOWING && ci.hCursor != IntPtr.Zero && ci.hCursor != _lastReportedCursor)
                                {
                                    _lastReportedCursor = ci.hCursor;
                                    string shape = DetectCursorShape(ci.hCursor);
                                    if (shape != _lastReportedShape)
                                    {
                                        _lastReportedShape = shape;
                                        string shapeJson = string.Format("{{\"type\":\"cursor:shape\",\"shape\":\"{0}\"}}", shape);
                                        byte[] shapeBytes = Encoding.UTF8.GetBytes(shapeJson);
                                        await ws.SendAsync(new ArraySegment<byte>(shapeBytes), WebSocketMessageType.Text, true, ct);
                                    }
                                }
                            }
                        }
                        catch { }
                    }

                    // High-precision frame pacing (15 FPS = ~66.6 ms)
                    nextFrameTicks += targetTicksPerFrame;
                    long remainingTicks = nextFrameTicks - sw.ElapsedTicks;
                    if (remainingTicks > 0)
                    {
                        int delayMs = (int)(remainingTicks * 1000 / System.Diagnostics.Stopwatch.Frequency);
                        if (delayMs > 1) await Task.Delay(delayMs, ct);
                    }
                    else
                    {
                        // Dropped frame or falling behind: reset pacing baseline
                        nextFrameTicks = sw.ElapsedTicks;
                    }
                }
                catch (OperationCanceledException)
                {
                    break;
                }
                catch (WebSocketException ex)
                {
                    Log(string.Format("Relay socket disconnected: {0}", ex.Message));
                    break;
                }
            }
        }

        /// <summary>
        /// Duplex Receive Loop: Listens for incoming input events and relay control messages.
        /// </summary>
        private async Task RunStreamReceiveLoopAsync(ClientWebSocket ws, CancellationToken ct)
        {
            byte[] buffer = new byte[8192];
            while (!ct.IsCancellationRequested && ws.State == WebSocketState.Open && !_isDisposed)
            {
                try
                {
                    WebSocketReceiveResult result = await ws.ReceiveAsync(new ArraySegment<byte>(buffer), ct);
                    if (result.MessageType == WebSocketMessageType.Close)
                    {
                        Log("Relay broker signaled socket closure.");
                        break;
                    }

                    if (result.MessageType == WebSocketMessageType.Binary)
                    {
                        // Binary input packets: Opcode 0x02 (Mouse), Opcode 0x03 (Keyboard)
                        if (result.Count > 0 && OnInputPacketReceived != null)
                        {
                            OnInputPacketReceived(buffer, result.Count);
                        }
                    }
                    else if (result.MessageType == WebSocketMessageType.Text)
                    {
                        // Control messages (e.g. relay:status with peer_disconnected)
                        string text = Encoding.UTF8.GetString(buffer, 0, result.Count);
                        if (text.Contains("peer_disconnected"))
                        {
                            Log("Remote controller disconnected from session.");
                            break;
                        }
                    }
                }
                catch (OperationCanceledException)
                {
                    break;
                }
                catch (Exception ex)
                {
                    Log(string.Format("Relay receive loop error: {0}", ex.Message));
                    break;
                }
            }
        }

        #endregion

        #region Diagnostics & Logging

        private void Log(string message)
        {
            if (OnLogMessage != null)
            {
                OnLogMessage(message);
            }
            else
            {
                Console.WriteLine(string.Format("[{0:HH:mm:ss.fff}] [ScreenCapturer] {1}", DateTime.Now, message));
            }
        }

        #endregion

        #region IDisposable Implementation

        public void Dispose()
        {
            if (_isDisposed) return;
            _isDisposed = true;

            StopLiveStreaming();

            lock (_captureLock)
            {
                if (_screenGraphics != null) { _screenGraphics.Dispose(); _screenGraphics = null; }
                if (_screenBitmap != null) { _screenBitmap.Dispose(); _screenBitmap = null; }

                if (_thumbGraphics != null) { _thumbGraphics.Dispose(); _thumbGraphics = null; }
                if (_thumbBitmap != null) { _thumbBitmap.Dispose(); _thumbBitmap = null; }

                if (_streamGraphics != null) { _streamGraphics.Dispose(); _streamGraphics = null; }
                if (_streamBitmap != null) { _streamBitmap.Dispose(); _streamBitmap = null; }

                if (_thumbStream != null) { _thumbStream.Dispose(); }
                if (_streamStream != null) { _streamStream.Dispose(); }
            }

            Log("ScreenCapturer resources successfully disposed.");
        }

        #endregion
    }

    /// <summary>
    /// Flow-control gate limiting in-flight frames via acknowledgment protocol.
    /// Each sent frame increments the in-flight count. Each ACK (byte 0x06) from
    /// the browser decrements it. CanSend() returns false when MaxInFlight is reached,
    /// causing the capture loop to wait instead of buffering more frames.
    /// </summary>
    public class FrameGate
    {
        private readonly object _l = new object();
        private readonly System.Collections.Generic.Queue<long> _sent = new System.Collections.Generic.Queue<long>();
        public int MaxInFlight = 1;
        public double AckMs;   // EWMA send-to-ack: real video latency measure
        private static double ToMs(long t) { return t * 1000.0 / System.Diagnostics.Stopwatch.Frequency; }

        public void Reset() { lock (_l) { _sent.Clear(); AckMs = 0; } }
        public void OnSent() { lock (_l) _sent.Enqueue(System.Diagnostics.Stopwatch.GetTimestamp()); }
        public void OnAck()
        {
            lock (_l)
            {
                if (_sent.Count == 0) return;
                double ms = ToMs(System.Diagnostics.Stopwatch.GetTimestamp() - _sent.Dequeue());
                AckMs = AckMs == 0 ? ms : AckMs * 0.7 + ms * 0.3;
            }
        }
        public bool CanSend()
        {
            lock (_l)
            {
                if (_sent.Count < MaxInFlight) return true;
                // Timeout safety: 150 ms prevents pause on dropped ACK while avoiding queue build-up
                if (ToMs(System.Diagnostics.Stopwatch.GetTimestamp() - _sent.Peek()) > 150)
                {
                    _sent.Clear();
                    return true;
                }
                return false;
            }
        }
    }
}
