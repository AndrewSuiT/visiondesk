// ============================================================================
// VisionDesk - Windows Background Agent
// File: agent/AuthDialog.cs
//
// TopMost Peer Support Connection Request Authorization Dialog.
// Displays caller metadata, formatted machine ID, 30s countdown auto-reject,
// and returns user decision for 'peer:auth_response'.
// Compatible with .NET Framework 4.8 / C# 5 (csc.exe build).
// ============================================================================

using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace VisionDesk.Agent
{
    /// <summary>
    /// Encapsulates incoming peer authorization request parameters.
    /// </summary>
    public class AuthPromptRequest
    {
        public string SessionId { get; set; }
        public string RequesterId { get; set; }
        public string RequesterName { get; set; }
        public string TargetMachineId { get; set; }
        public string RequestedAccess { get; set; }
        public int TimeoutSeconds { get; set; }

        public AuthPromptRequest()
        {
            TimeoutSeconds = 30;
            RequestedAccess = "Control Total de Mouse y Teclado";
            SessionId = "";
            RequesterId = "";
            RequesterName = "";
            TargetMachineId = "";
        }
    }

    /// <summary>
    /// User decision output matching peer:auth_response payload.
    /// </summary>
    public class AuthPromptResponse
    {
        public string SessionId { get; set; }
        public bool Granted { get; set; }
        public string Reason { get; set; } // "user_accepted", "user_declined", "timeout", "cancelled", "busy"

        public AuthPromptResponse()
        {
            SessionId = "";
            Granted = false;
            Reason = "user_declined";
        }

        public AuthPromptResponse(string sessionId, bool granted, string reason)
        {
            SessionId = sessionId;
            Granted = granted;
            Reason = reason;
        }
    }

    /// <summary>
    /// Modal TopMost Windows Form for peer authorization.
    /// </summary>
    public class AuthDialog : Form
    {
        private static readonly object _activeLock = new object();
        private static AuthDialog _currentActiveDialog = null;

        private readonly AuthPromptRequest _request;
        private AuthPromptResponse _response;
        private System.Windows.Forms.Timer _timer;
        private int _secondsRemaining;

        private Label _lblCountdown;
        private Button _btnAccept;
        private Button _btnReject;

        public AuthPromptResponse Response
        {
            get { return _response; }
        }

        public AuthDialog(AuthPromptRequest request)
        {
            _request = request != null ? request : new AuthPromptRequest();
            _secondsRemaining = _request.TimeoutSeconds > 0 ? _request.TimeoutSeconds : 30;
            _response = new AuthPromptResponse(_request.SessionId, false, "timeout");

            InitializeComponents();
        }

        private void InitializeComponents()
        {
            this.Text = "VisionDesk - Solicitud de Soporte Remoto";
            this.ClientSize = new Size(460, 310);
            this.FormBorderStyle = FormBorderStyle.FixedDialog;
            this.StartPosition = FormStartPosition.CenterScreen;
            this.TopMost = true;
            this.MaximizeBox = false;
            this.MinimizeBox = false;
            this.ShowInTaskbar = true;
            this.BackColor = Color.White;
            this.Font = new Font("Segoe UI", 9F, FontStyle.Regular, GraphicsUnit.Point);

            // 1. Header Panel
            Panel headerPanel = new Panel();
            headerPanel.Dock = DockStyle.Top;
            headerPanel.Height = 65;
            headerPanel.BackColor = Color.FromArgb(15, 23, 42); // Slate-900

            Label lblTitle = new Label();
            lblTitle.Text = "Solicitud de Control Remoto Entrante";
            lblTitle.ForeColor = Color.White;
            lblTitle.Font = new Font("Segoe UI", 11.25F, FontStyle.Bold);
            lblTitle.Location = new Point(16, 12);
            lblTitle.AutoSize = true;
            headerPanel.Controls.Add(lblTitle);

            Label lblSubtitle = new Label();
            lblSubtitle.Text = "Una estación de soporte técnico solicita interacción directa";
            lblSubtitle.ForeColor = Color.FromArgb(148, 163, 184); // Slate-400
            lblSubtitle.Font = new Font("Segoe UI", 8.25F);
            lblSubtitle.Location = new Point(17, 36);
            lblSubtitle.AutoSize = true;
            headerPanel.Controls.Add(lblSubtitle);

            this.Controls.Add(headerPanel);

            // 2. Info Card Panel
            Panel cardPanel = new Panel();
            cardPanel.Location = new Point(16, 78);
            cardPanel.Size = new Size(428, 110);
            cardPanel.BackColor = Color.FromArgb(248, 250, 252); // Slate-50
            cardPanel.BorderStyle = BorderStyle.FixedSingle;

            Label lblReq = new Label();
            lblReq.Text = string.Format("Operador / Equipo:  {0}", string.IsNullOrEmpty(_request.RequesterName) ? "Soporte Remoto" : _request.RequesterName);
            lblReq.Font = new Font("Segoe UI", 9.5F, FontStyle.Bold);
            lblReq.ForeColor = Color.FromArgb(30, 41, 59);
            lblReq.Location = new Point(12, 12);
            lblReq.AutoSize = true;
            cardPanel.Controls.Add(lblReq);

            Label lblId = new Label();
            lblId.Text = string.Format("ID de Estación:       {0}", FormatMachineId(_request.RequesterId));
            lblId.Font = new Font("Segoe UI", 9F);
            lblId.ForeColor = Color.FromArgb(71, 85, 105);
            lblId.Location = new Point(12, 38);
            lblId.AutoSize = true;
            cardPanel.Controls.Add(lblId);

            Label lblAccess = new Label();
            lblAccess.Text = string.Format("Permiso Solicitado:   {0}", _request.RequestedAccess);
            lblAccess.Font = new Font("Segoe UI", 9F);
            lblAccess.ForeColor = Color.FromArgb(71, 85, 105);
            lblAccess.Location = new Point(12, 60);
            lblAccess.AutoSize = true;
            cardPanel.Controls.Add(lblAccess);

            Label lblWarn = new Label();
            lblWarn.Text = "Si usted no solicitó soporte, rechace esta solicitud de inmediato.";
            lblWarn.Font = new Font("Segoe UI", 8F, FontStyle.Italic);
            lblWarn.ForeColor = Color.FromArgb(180, 83, 9); // Amber-700
            lblWarn.Location = new Point(12, 84);
            lblWarn.AutoSize = true;
            cardPanel.Controls.Add(lblWarn);

            this.Controls.Add(cardPanel);

            // 3. Countdown Label
            _lblCountdown = new Label();
            _lblCountdown.Text = string.Format("Auto-rechazo en: {0} segundos...", _secondsRemaining);
            _lblCountdown.ForeColor = Color.FromArgb(100, 116, 139);
            _lblCountdown.Font = new Font("Segoe UI", 8.5F, FontStyle.Regular);
            _lblCountdown.Location = new Point(16, 198);
            _lblCountdown.AutoSize = true;
            this.Controls.Add(_lblCountdown);

            // 4. Action Buttons
            _btnAccept = new Button();
            _btnAccept.Text = "Aceptar (Control)";
            _btnAccept.Location = new Point(190, 240);
            _btnAccept.Size = new Size(130, 36);
            _btnAccept.BackColor = Color.FromArgb(16, 185, 129); // Emerald-500
            _btnAccept.ForeColor = Color.White;
            _btnAccept.Font = new Font("Segoe UI", 9.5F, FontStyle.Bold);
            _btnAccept.FlatStyle = FlatStyle.Flat;
            _btnAccept.FlatAppearance.BorderSize = 0;
            _btnAccept.Cursor = Cursors.Hand;
            _btnAccept.Click += BtnAccept_Click;
            this.Controls.Add(_btnAccept);

            _btnReject = new Button();
            _btnReject.Text = "Rechazar";
            _btnReject.Location = new Point(330, 240);
            _btnReject.Size = new Size(114, 36);
            _btnReject.BackColor = Color.FromArgb(220, 38, 38); // Red-600
            _btnReject.ForeColor = Color.White;
            _btnReject.Font = new Font("Segoe UI", 9.5F, FontStyle.Bold);
            _btnReject.FlatStyle = FlatStyle.Flat;
            _btnReject.FlatAppearance.BorderSize = 0;
            _btnReject.Cursor = Cursors.Hand;
            _btnReject.Click += BtnReject_Click;
            this.Controls.Add(_btnReject);

            this.AcceptButton = _btnAccept;
            this.CancelButton = _btnReject;

            // 5. Timer Initialization
            _timer = new System.Windows.Forms.Timer();
            _timer.Interval = 1000;
            _timer.Tick += Timer_Tick;

            this.Load += AuthDialog_Load;
            this.FormClosing += AuthDialog_FormClosing;
        }

        private void AuthDialog_Load(object sender, EventArgs e)
        {
            ForceToForeground();
            try
            {
                System.Media.SystemSounds.Exclamation.Play();
            }
            catch { }
            if (_timer != null)
            {
                _timer.Start();
            }

            // Headless CI Test Automation Hook
            try
            {
                string autoPrompt = Environment.GetEnvironmentVariable("VISIONDESK_TEST_AUTO_PROMPT");
                if (!string.IsNullOrEmpty(autoPrompt))
                {
                    autoPrompt = autoPrompt.Trim().ToLowerInvariant();
                    if (autoPrompt == "accept")
                    {
                        this.BeginInvoke((MethodInvoker)delegate()
                        {
                            BtnAccept_Click(this, EventArgs.Empty);
                        });
                        return;
                    }
                    if (autoPrompt == "reject")
                    {
                        this.BeginInvoke((MethodInvoker)delegate()
                        {
                            BtnReject_Click(this, EventArgs.Empty);
                        });
                        return;
                    }
                    if (autoPrompt == "timeout")
                    {
                        _secondsRemaining = 1;
                    }
                }
            }
            catch { }
        }

        private void Timer_Tick(object sender, EventArgs e)
        {
            _secondsRemaining--;
            if (_secondsRemaining <= 0)
            {
                if (_timer != null) _timer.Stop();
                if (_lblCountdown != null) _lblCountdown.Text = "Tiempo agotado. Solicitud rechazada.";
                _response = new AuthPromptResponse(_request.SessionId, false, "timeout");
                this.DialogResult = DialogResult.Cancel;
                this.Close();
            }
            else
            {
                if (_secondsRemaining % 5 == 0)
                {
                    try
                    {
                        SetWindowPos(this.Handle, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
                    }
                    catch { }
                }

                if (_lblCountdown != null)
                {
                    _lblCountdown.Text = string.Format("Auto-rechazo en: {0} segundos...", _secondsRemaining);
                    if (_secondsRemaining <= 10)
                    {
                        _lblCountdown.ForeColor = Color.FromArgb(220, 38, 38); // Red indicator
                    }
                }
            }
        }

        private void BtnAccept_Click(object sender, EventArgs e)
        {
            if (_timer != null) _timer.Stop();
            _response = new AuthPromptResponse(_request.SessionId, true, "user_accepted");
            this.DialogResult = DialogResult.OK;
            this.Close();
        }

        private void BtnReject_Click(object sender, EventArgs e)
        {
            if (_timer != null) _timer.Stop();
            _response = new AuthPromptResponse(_request.SessionId, false, "user_declined");
            this.DialogResult = DialogResult.Cancel;
            this.Close();
        }

        private void AuthDialog_FormClosing(object sender, FormClosingEventArgs e)
        {
            if (_timer != null) _timer.Stop();
            if (_response == null)
            {
                _response = new AuthPromptResponse(_request.SessionId, false, "user_declined");
            }
        }

        private static string FormatMachineId(string raw)
        {
            if (string.IsNullOrEmpty(raw)) return "Desconocido";
            string digits = raw.Replace(" ", "").Trim();
            if (digits.Length == 9)
            {
                return string.Format("{0} {1} {2}", digits.Substring(0, 3), digits.Substring(3, 3), digits.Substring(6, 3));
            }
            return raw;
        }

        #region Win32 Foreground Enforcers

        private const int SW_RESTORE = 9;
        private static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
        private const uint SWP_NOSIZE = 0x0001;
        private const uint SWP_NOMOVE = 0x0002;
        private const uint SWP_SHOWWINDOW = 0x0040;
        private const int WS_EX_TOPMOST = 0x00000008;

        [DllImport("user32.dll")]
        private static extern bool SetForegroundWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

        [DllImport("user32.dll")]
        private static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll")]
        private static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr ProcessId);

        [DllImport("user32.dll")]
        private static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

        [DllImport("kernel32.dll")]
        private static extern uint GetCurrentThreadId();

        [DllImport("user32.dll")]
        private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

        [DllImport("user32.dll")]
        private static extern bool BringWindowToTop(IntPtr hWnd);

        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams cp = base.CreateParams;
                cp.ExStyle |= WS_EX_TOPMOST;
                return cp;
            }
        }

        public void ForceToForeground()
        {
            try
            {
                IntPtr hWnd = this.Handle;
                IntPtr foreWnd = GetForegroundWindow();
                uint foreThread = GetWindowThreadProcessId(foreWnd, IntPtr.Zero);
                uint appThread = GetCurrentThreadId();

                if (foreThread != appThread && foreThread != 0)
                {
                    AttachThreadInput(foreThread, appThread, true);
                    SetWindowPos(hWnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
                    ShowWindow(hWnd, SW_RESTORE);
                    BringWindowToTop(hWnd);
                    SetForegroundWindow(hWnd);
                    AttachThreadInput(foreThread, appThread, false);
                }
                else
                {
                    SetWindowPos(hWnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
                    ShowWindow(hWnd, SW_RESTORE);
                    BringWindowToTop(hWnd);
                    SetForegroundWindow(hWnd);
                }

                this.TopMost = true;
                this.BringToFront();
                this.Activate();
                this.Focus();
                if (_btnAccept != null)
                {
                    _btnAccept.Focus();
                }
            }
            catch { }
        }

        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);
            ForceToForeground();
        }

        #endregion

        #region Static Threading Helpers

        /// <summary>
        /// Displays the TopMost dialog asynchronously on an STA thread without blocking the agent's network loop.
        /// </summary>
        public static Task<AuthPromptResponse> ShowPromptAsync(AuthPromptRequest request)
        {
            TaskCompletionSource<AuthPromptResponse> tcs = new TaskCompletionSource<AuthPromptResponse>();

            lock (_activeLock)
            {
                if (_currentActiveDialog != null)
                {
                    tcs.SetResult(new AuthPromptResponse(request != null ? request.SessionId : "", false, "busy"));
                    return tcs.Task;
                }
            }

            Thread staThread = new Thread(delegate()
            {
                try
                {
                    using (AuthDialog dialog = new AuthDialog(request))
                    {
                        lock (_activeLock)
                        {
                            _currentActiveDialog = dialog;
                        }

                        try
                        {
                            dialog.ShowDialog();
                            tcs.TrySetResult(dialog.Response);
                        }
                        finally
                        {
                            lock (_activeLock)
                            {
                                if (_currentActiveDialog == dialog)
                                {
                                    _currentActiveDialog = null;
                                }
                            }
                        }
                    }
                }
                catch (Exception ex)
                {
                    tcs.TrySetResult(new AuthPromptResponse(request != null ? request.SessionId : "", false, "error: " + ex.Message));
                }
            });

            staThread.SetApartmentState(ApartmentState.STA);
            staThread.IsBackground = true;
            staThread.Start();

            return tcs.Task;
        }

        /// <summary>
        /// Dismisses the currently active dialog programmatically if the remote peer cancels or disconnects.
        /// </summary>
        public static void DismissActiveDialog(string sessionId)
        {
            lock (_activeLock)
            {
                if (_currentActiveDialog != null)
                {
                    if (string.IsNullOrEmpty(sessionId) || _currentActiveDialog._request.SessionId == sessionId)
                    {
                        try
                        {
                            _currentActiveDialog.Invoke((MethodInvoker)delegate()
                            {
                                if (_currentActiveDialog != null)
                                {
                                    _currentActiveDialog._response = new AuthPromptResponse(_currentActiveDialog._request.SessionId, false, "cancelled");
                                    _currentActiveDialog.Close();
                                }
                            });
                        }
                        catch { }
                    }
                }
            }
        }

        #endregion
    }
}
