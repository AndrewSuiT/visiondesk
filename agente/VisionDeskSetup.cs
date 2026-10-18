// ============================================================================
// VisionDesk - Windows Agent Setup Wizard (Instalador Asistente Paso a Paso)
// File: agent/VisionDeskSetup.cs
//
// GUI Setup Wizard (Estilo "Siguiente > Siguiente > Instalar")
// - No requiere dependencias externas (compilable con csc.exe nativo)
// - Permite configurar Server URL (desk.manzanares.pe), Sucursal, Alias y Clave
// - Instala en C:\VisionDesk\ y configura auto-arranque silencioso con Windows
// ============================================================================

using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Windows.Forms;
using Microsoft.Win32;

namespace VisionDesk.Setup
{
    public class SetupForm : Form
    {
        private int currentStep = 0;
        private const int TOTAL_STEPS = 5;

        // UI Panels & Controls
        private Panel headerPanel;
        private Label lblHeaderTitle;
        private Label lblHeaderSubtitle;
        private Panel contentPanel;
        private Panel footerPanel;
        private Button btnBack;
        private Button btnNext;
        private Button btnCancel;

        // Step Panels
        private Panel[] stepPanels;

        // Step 1: Welcome Controls
        private Label lblWelcomeTitle;
        private Label lblWelcomeDesc;

        // Step 2: Server Config Controls
        private TextBox txtServerUrl;
        private TextBox txtMasterToken;

        // Step 3: Branch / Machine Identity Controls
        private ComboBox cmbBranchId;
        private TextBox txtAlias;
        private TextBox txtPassword;

        // Step 4: Installation Path & Options
        private TextBox txtInstallPath;
        private CheckBox chkAutoStart;
        private CheckBox chkStartNow;
        private ProgressBar progressBar;
        private Label lblStatus;

        // Step 5: Finished Controls
        private Label lblFinishedTitle;
        private Label lblFinishedDesc;

        [STAThread]
        public static void Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            if (args != null && args.Length > 0 && (args[0] == "--info" || args[0] == "--credentials" || args[0] == "-i"))
            {
                Application.Run(new CredentialsForm());
                return;
            }
            Application.Run(new SetupForm());
        }

        public SetupForm()
        {
            InitializeComponent();
            PreloadExistingConfig();
            ShowStep(0);
        }

        private void PreloadExistingConfig()
        {
            try
            {
                string cfgPath = @"C:\VisionDesk\config.json";
                if (!File.Exists(cfgPath))
                {
                    cfgPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "config.json");
                }
                if (File.Exists(cfgPath))
                {
                    string json = File.ReadAllText(cfgPath);
                    string s = CredentialsForm.ExtractJsonString(json, "serverUrl");
                    if (!string.IsNullOrEmpty(s)) txtServerUrl.Text = s;
                    string t = CredentialsForm.ExtractJsonString(json, "masterToken");
                    if (!string.IsNullOrEmpty(t)) txtMasterToken.Text = t;
                    string b = CredentialsForm.ExtractJsonString(json, "branchId");
                    if (!string.IsNullOrEmpty(b))
                    {
                        if (cmbBranchId.Items.Contains(b))
                        {
                            cmbBranchId.SelectedItem = b;
                        }
                        else
                        {
                            cmbBranchId.Items.Add(b);
                            cmbBranchId.SelectedItem = b;
                        }
                    }
                    string a = CredentialsForm.ExtractJsonString(json, "alias");
                    if (!string.IsNullOrEmpty(a)) txtAlias.Text = a;
                    string p = CredentialsForm.ExtractJsonString(json, "fixedPassword");
                    if (!string.IsNullOrEmpty(p)) txtPassword.Text = p;

                    string installDir = Path.GetDirectoryName(Path.GetFullPath(cfgPath));
                    if (!string.IsNullOrEmpty(installDir) && txtInstallPath != null)
                    {
                        txtInstallPath.Text = installDir;
                    }
                }
            }
            catch { }
        }

        private void InitializeComponent()
        {
            this.Text = "Instalador de VisionDesk - Sucursales";
            this.Size = new Size(580, 480);
            this.StartPosition = FormStartPosition.CenterScreen;
            this.FormBorderStyle = FormBorderStyle.FixedDialog;
            this.MaximizeBox = false;
            this.MinimizeBox = true;
            this.Font = new Font("Segoe UI", 9F, FontStyle.Regular, GraphicsUnit.Point);
            this.BackColor = Color.FromArgb(243, 244, 246);

            // Header Panel
            headerPanel = new Panel();
            headerPanel.Dock = DockStyle.Top;
            headerPanel.Height = 75;
            headerPanel.BackColor = Color.FromArgb(17, 24, 39); // Slate-900

            lblHeaderTitle = new Label();
            lblHeaderTitle.Text = "VisionDesk - Control y Monitoreo de Sucursales";
            lblHeaderTitle.Font = new Font("Segoe UI", 12F, FontStyle.Bold, GraphicsUnit.Point);
            lblHeaderTitle.ForeColor = Color.White;
            lblHeaderTitle.Location = new Point(20, 15);
            lblHeaderTitle.AutoSize = true;

            lblHeaderSubtitle = new Label();
            lblHeaderSubtitle.Text = "Asistente de configuración e instalación en Windows";
            lblHeaderSubtitle.Font = new Font("Segoe UI", 9F, FontStyle.Regular, GraphicsUnit.Point);
            lblHeaderSubtitle.ForeColor = Color.FromArgb(156, 163, 175);
            lblHeaderSubtitle.Location = new Point(20, 42);
            lblHeaderSubtitle.AutoSize = true;

            headerPanel.Controls.Add(lblHeaderTitle);
            headerPanel.Controls.Add(lblHeaderSubtitle);

            // Footer Panel
            footerPanel = new Panel();
            footerPanel.Dock = DockStyle.Bottom;
            footerPanel.Height = 55;
            footerPanel.BackColor = Color.FromArgb(229, 231, 235);

            btnCancel = new Button();
            btnCancel.Text = "Cancelar";
            btnCancel.Size = new Size(85, 32);
            btnCancel.Location = new Point(470, 11);
            btnCancel.Click += (s, e) => { this.Close(); };

            btnNext = new Button();
            btnNext.Text = "Siguiente >";
            btnNext.Size = new Size(95, 32);
            btnNext.Location = new Point(365, 11);
            btnNext.BackColor = Color.FromArgb(37, 99, 235); // Blue-600
            btnNext.ForeColor = Color.White;
            btnNext.FlatStyle = FlatStyle.Flat;
            btnNext.Click += BtnNext_Click;

            btnBack = new Button();
            btnBack.Text = "< Atrás";
            btnBack.Size = new Size(85, 32);
            btnBack.Location = new Point(270, 11);
            btnBack.Click += (s, e) => { if (currentStep > 0) ShowStep(currentStep - 1); };

            footerPanel.Controls.Add(btnBack);
            footerPanel.Controls.Add(btnNext);
            footerPanel.Controls.Add(btnCancel);

            // Content Panel
            contentPanel = new Panel();
            contentPanel.Dock = DockStyle.Fill;
            contentPanel.Padding = new Padding(25);

            // Create 5 Step Panels
            stepPanels = new Panel[TOTAL_STEPS];
            for (int i = 0; i < TOTAL_STEPS; i++)
            {
                stepPanels[i] = new Panel();
                stepPanels[i].Dock = DockStyle.Fill;
                stepPanels[i].Visible = false;
                contentPanel.Controls.Add(stepPanels[i]);
            }

            // Build individual steps
            BuildStep1_Welcome(stepPanels[0]);
            BuildStep2_Server(stepPanels[1]);
            BuildStep3_Identity(stepPanels[2]);
            BuildStep4_Install(stepPanels[3]);
            BuildStep5_Finished(stepPanels[4]);

            this.Controls.Add(contentPanel);
            this.Controls.Add(headerPanel);
            this.Controls.Add(footerPanel);
        }

        private void BuildStep1_Welcome(Panel p)
        {
            lblWelcomeTitle = new Label();
            lblWelcomeTitle.Text = "Bienvenido al Asistente de Instalación";
            lblWelcomeTitle.Font = new Font("Segoe UI", 12F, FontStyle.Bold);
            lblWelcomeTitle.Location = new Point(10, 15);
            lblWelcomeTitle.AutoSize = true;

            lblWelcomeDesc = new Label();
            lblWelcomeDesc.Text = "Este instalador configurará esta PC para enlazarse de forma automática " +
                                  "y segura al Panel Central de Sucursales de VisionDesk.\n\n" +
                                  "• Monitoreo pasivo continuo para auditoría de cajas.\n" +
                                  "• Soporte remoto interactivo con 1 clic.\n" +
                                  "• Inicio silencioso y transparente en segundo plano.\n" +
                                  "• Consumo mínimo de recursos (< 15 MB RAM).\n\n" +
                                  "Haga clic en 'Siguiente' para comenzar la configuración.";
            lblWelcomeDesc.Location = new Point(12, 55);
            lblWelcomeDesc.Size = new Size(500, 180);

            p.Controls.Add(lblWelcomeTitle);
            p.Controls.Add(lblWelcomeDesc);
        }

        private void BuildStep2_Server(Panel p)
        {
            Label lblTitle = new Label();
            lblTitle.Text = "Paso 1: Conexión con el Servidor Central";
            lblTitle.Font = new Font("Segoe UI", 11F, FontStyle.Bold);
            lblTitle.Location = new Point(10, 10);
            lblTitle.AutoSize = true;

            Label lblDesc = new Label();
            lblDesc.Text = "Ingrese la dirección del servidor central (subdominio o IP) y el token de administración:";
            lblDesc.Location = new Point(12, 35);
            lblDesc.Size = new Size(500, 30);

            Label lblUrl = new Label();
            lblUrl.Text = "Servidor WebSocket (WSS):";
            lblUrl.Font = new Font("Segoe UI", 9F, FontStyle.Bold);
            lblUrl.Location = new Point(12, 75);
            lblUrl.AutoSize = true;

            txtServerUrl = new TextBox();
            txtServerUrl.Text = "wss://desk.manzanares.pe/ws";
            txtServerUrl.Location = new Point(15, 95);
            txtServerUrl.Size = new Size(480, 25);

            Label lblToken = new Label();
            lblToken.Text = "Token de Administración Central (ADMIN_TOKEN):";
            lblToken.Font = new Font("Segoe UI", 9F, FontStyle.Bold);
            lblToken.Location = new Point(12, 135);
            lblToken.AutoSize = true;

            txtMasterToken = new TextBox();
            txtMasterToken.Text = "CAhXJFz6HUSC1K8KqPsZ7mKk2QkGHxraVkUOJ0hUeBg";
            txtMasterToken.Location = new Point(15, 155);
            txtMasterToken.Size = new Size(480, 25);

            Label lblHint = new Label();
            lblHint.Text = "Token maestro que autoriza el control desde el panel central (desk.manzanares.pe).";
            lblHint.ForeColor = Color.FromArgb(107, 114, 128);
            lblHint.Location = new Point(15, 190);
            lblHint.Size = new Size(480, 25);

            p.Controls.Add(lblTitle);
            p.Controls.Add(lblDesc);
            p.Controls.Add(lblUrl);
            p.Controls.Add(txtServerUrl);
            p.Controls.Add(lblToken);
            p.Controls.Add(txtMasterToken);
            p.Controls.Add(lblHint);
        }

        private void BuildStep3_Identity(Panel p)
        {
            Label lblTitle = new Label();
            lblTitle.Text = "Paso 2: Identidad de la Sucursal y Caja";
            lblTitle.Font = new Font("Segoe UI", 11F, FontStyle.Bold);
            lblTitle.Location = new Point(10, 10);
            lblTitle.AutoSize = true;

            Label lblDesc = new Label();
            lblDesc.Text = "Seleccione o escriba el nombre de la caja (ej: computo, caja_01, administracion):";
            lblDesc.Location = new Point(12, 35);
            lblDesc.Size = new Size(500, 25);

            Label lblBranch = new Label();
            lblBranch.Text = "Identificador de Sucursal / Caja (ID):";
            lblBranch.Font = new Font("Segoe UI", 9F, FontStyle.Bold);
            lblBranch.Location = new Point(12, 65);
            lblBranch.AutoSize = true;

            cmbBranchId = new ComboBox();
            cmbBranchId.Items.AddRange(new string[] {
                "computo", "caja_01", "caja_02", "administracion", "cayma", "cerro_colorado", "yanahuara", "paucarpata", "bustamante", "centro", "almacen"
            });
            cmbBranchId.Text = "computo";
            cmbBranchId.Location = new Point(15, 85);
            cmbBranchId.Size = new Size(480, 25);
            cmbBranchId.SelectedIndexChanged += (s, e) => {
                string val = cmbBranchId.Text.ToUpper().Replace("-", "_");
                txtAlias.Text = "AQP-" + val + "-01";
            };

            Label lblAlias = new Label();
            lblAlias.Text = "Nombre / Alias Visible en el Panel:";
            lblAlias.Font = new Font("Segoe UI", 9F, FontStyle.Bold);
            lblAlias.Location = new Point(12, 120);
            lblAlias.AutoSize = true;

            txtAlias = new TextBox();
            txtAlias.Text = "SOPORTE-TECNICO";
            txtAlias.Location = new Point(15, 140);
            txtAlias.Size = new Size(480, 25);

            Label lblPass = new Label();
            lblPass.Text = "Contraseña de esta PC (Para Soporte Punto a Punto):";
            lblPass.Font = new Font("Segoe UI", 9F, FontStyle.Bold);
            lblPass.Location = new Point(12, 175);
            lblPass.AutoSize = true;

            txtPassword = new TextBox();
            txtPassword.Text = "Odisea_11$";
            txtPassword.PasswordChar = '*';
            txtPassword.Location = new Point(15, 195);
            txtPassword.Size = new Size(480, 25);

            p.Controls.Add(lblTitle);
            p.Controls.Add(lblDesc);
            p.Controls.Add(lblBranch);
            p.Controls.Add(cmbBranchId);
            p.Controls.Add(lblAlias);
            p.Controls.Add(txtAlias);
            p.Controls.Add(lblPass);
            p.Controls.Add(txtPassword);
        }

        private void BuildStep4_Install(Panel p)
        {
            Label lblTitle = new Label();
            lblTitle.Text = "Paso 3: Opciones de Instalación y Arranque";
            lblTitle.Font = new Font("Segoe UI", 11F, FontStyle.Bold);
            lblTitle.Location = new Point(10, 10);
            lblTitle.AutoSize = true;

            Label lblPath = new Label();
            lblPath.Text = "Carpeta de instalación:";
            lblPath.Font = new Font("Segoe UI", 9F, FontStyle.Bold);
            lblPath.Location = new Point(12, 40);
            lblPath.AutoSize = true;

            txtInstallPath = new TextBox();
            txtInstallPath.Text = @"C:\VisionDesk";
            txtInstallPath.Location = new Point(15, 60);
            txtInstallPath.Size = new Size(480, 25);

            chkAutoStart = new CheckBox();
            chkAutoStart.Text = "Iniciar automáticamente al encender Windows (segundo plano silencioso)";
            chkAutoStart.Font = new Font("Segoe UI", 9F, FontStyle.Bold);
            chkAutoStart.Checked = true;
            chkAutoStart.Location = new Point(15, 100);
            chkAutoStart.Size = new Size(480, 25);

            chkStartNow = new CheckBox();
            chkStartNow.Text = "Iniciar el Agente inmediatamente al finalizar la instalación";
            chkStartNow.Checked = true;
            chkStartNow.Location = new Point(15, 130);
            chkStartNow.Size = new Size(480, 25);

            progressBar = new ProgressBar();
            progressBar.Location = new Point(15, 170);
            progressBar.Size = new Size(480, 20);
            progressBar.Visible = false;

            lblStatus = new Label();
            lblStatus.Text = "Listo para instalar.";
            lblStatus.ForeColor = Color.FromArgb(75, 85, 99);
            lblStatus.Location = new Point(15, 195);
            lblStatus.Size = new Size(480, 25);

            p.Controls.Add(lblTitle);
            p.Controls.Add(lblPath);
            p.Controls.Add(txtInstallPath);
            p.Controls.Add(chkAutoStart);
            p.Controls.Add(chkStartNow);
            p.Controls.Add(progressBar);
            p.Controls.Add(lblStatus);
        }

        private void BuildStep5_Finished(Panel p)
        {
            lblFinishedTitle = new Label();
            lblFinishedTitle.Text = "¡Instalación Completada con Éxito!";
            lblFinishedTitle.Font = new Font("Segoe UI", 13F, FontStyle.Bold);
            lblFinishedTitle.ForeColor = Color.FromArgb(22, 101, 52); // Green-800
            lblFinishedTitle.Location = new Point(10, 15);
            lblFinishedTitle.AutoSize = true;

            lblFinishedDesc = new Label();
            lblFinishedDesc.Text = "El agente VisionDesk ha sido instalado y configurado correctamente.\n\n" +
                                   "• Servidor enlazado: " + txtServerUrl.Text + "\n" +
                                   "• Identificador de máquina registrado en segundo plano.\n" +
                                   "• Esta PC ya es visible en el Panel Central Administrativo.\n\n" +
                                   "Para realizar ajustes en el futuro, simplemente edite el archivo 'config.json' " +
                                   "o vuelva a ejecutar este instalador.\n\nHaga clic en 'Finalizar' para cerrar el asistente.";
            lblFinishedDesc.Location = new Point(12, 60);
            lblFinishedDesc.Size = new Size(500, 180);

            p.Controls.Add(lblFinishedTitle);
            p.Controls.Add(lblFinishedDesc);
        }

        private void ShowStep(int step)
        {
            currentStep = step;
            for (int i = 0; i < TOTAL_STEPS; i++)
            {
                stepPanels[i].Visible = (i == step);
            }

            btnBack.Enabled = (step > 0 && step < 4);
            btnBack.Visible = (step < 4);

            if (step == 0)
            {
                btnNext.Text = "Siguiente >";
            }
            else if (step == 3)
            {
                btnNext.Text = "Instalar";
                btnNext.BackColor = Color.FromArgb(16, 185, 129); // Emerald-500
            }
            else if (step == 4)
            {
                btnNext.Text = "Finalizar";
                btnNext.BackColor = Color.FromArgb(37, 99, 235);
                btnCancel.Visible = false;
            }
            else
            {
                btnNext.Text = "Siguiente >";
                btnNext.BackColor = Color.FromArgb(37, 99, 235);
            }
        }

        private void BtnNext_Click(object sender, EventArgs e)
        {
            if (currentStep == 3)
            {
                // Perform Installation
                PerformInstallation();
            }
            else if (currentStep == 4)
            {
                this.Close();
            }
            else
            {
                ShowStep(currentStep + 1);
            }
        }

        private void PerformInstallation()
        {
            btnNext.Enabled = false;
            btnBack.Enabled = false;
            btnCancel.Enabled = false;
            progressBar.Visible = true;
            progressBar.Value = 10;
            lblStatus.Text = "Creando directorio de destino...";
            Application.DoEvents();

            try
            {
                string targetDir = txtInstallPath.Text.Trim();
                if (string.IsNullOrEmpty(targetDir)) targetDir = @"C:\VisionDesk";
                if (!Directory.Exists(targetDir)) Directory.CreateDirectory(targetDir);

                // Stop any running VisionDeskAgent instances to prevent file locking & port conflicts
                try
                {
                    Process[] existingAgents = Process.GetProcessesByName("VisionDeskAgent");
                    foreach (Process p in existingAgents)
                    {
                        try
                        {
                            p.Kill();
                            p.WaitForExit(2000);
                        }
                        catch { }
                    }
                    System.Threading.Thread.Sleep(300);
                }
                catch { }

                progressBar.Value = 30;
                lblStatus.Text = "Copiando binario del agente...";
                Application.DoEvents();

                string currentDir = AppDomain.CurrentDomain.BaseDirectory;
                string srcExe = Path.Combine(currentDir, "VisionDeskAgent.exe");
                string dstExe = Path.Combine(targetDir, "VisionDeskAgent.exe");

                if (!string.Equals(srcExe, dstExe, StringComparison.OrdinalIgnoreCase) && File.Exists(srcExe))
                {
                    File.Copy(srcExe, dstExe, true);
                }
                else if (!File.Exists(dstExe))
                {
                    // If running from source folder, check agent folder
                    string altSrc = Path.Combine(currentDir, @"..\agent\VisionDeskAgent.exe");
                    if (File.Exists(altSrc))
                    {
                        File.Copy(altSrc, dstExe, true);
                    }
                }

                string srcSetup = Path.Combine(currentDir, "VisionDeskSetup.exe");
                string dstSetup = Path.Combine(targetDir, "VisionDeskSetup.exe");
                if (!string.Equals(srcSetup, dstSetup, StringComparison.OrdinalIgnoreCase) && File.Exists(srcSetup))
                {
                    File.Copy(srcSetup, dstSetup, true);
                }
                else if (!File.Exists(dstSetup))
                {
                    string altSetup = Path.Combine(currentDir, @"..\agent\VisionDeskSetup.exe");
                    if (File.Exists(altSetup)) File.Copy(altSetup, dstSetup, true);
                }

                // Copy WebRTC runtime dependencies in lib/
                string srcLib = Path.Combine(currentDir, "lib");
                if (!Directory.Exists(srcLib) || Directory.GetFiles(srcLib, "*.dll").Length == 0)
                {
                    string altLib = Path.Combine(currentDir, @"..\agent\lib");
                    if (Directory.Exists(altLib) && Directory.GetFiles(altLib, "*.dll").Length > 0)
                    {
                        srcLib = altLib;
                    }
                }

                if (Directory.Exists(srcLib) && Directory.GetFiles(srcLib, "*.dll").Length > 0)
                {
                    string dstLib = Path.Combine(targetDir, "lib");
                    if (!Directory.Exists(dstLib)) Directory.CreateDirectory(dstLib);
                    foreach (string dll in Directory.GetFiles(srcLib, "*.dll"))
                    {
                        string dstDll = Path.Combine(dstLib, Path.GetFileName(dll));
                        if (!string.Equals(dll, dstDll, StringComparison.OrdinalIgnoreCase))
                        {
                            try { File.Copy(dll, dstDll, true); } catch { }
                        }
                    }
                }
                else
                {
                    string dstLibCheck = Path.Combine(targetDir, "lib");
                    if (!Directory.Exists(dstLibCheck) || Directory.GetFiles(dstLibCheck, "*.dll").Length == 0)
                    {
                        MessageBox.Show("Advertencia: No se encontraron las bibliotecas WebRTC en la carpeta 'lib'.\n" +
                            "Asegúrese de extraer la carpeta 'lib' junto al instalador para que el streaming funcione.",
                            "Bibliotecas no encontradas", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    }
                }

                try
                {
                    string desktopPath = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
                    string cmdPath = Path.Combine(desktopPath, "Mi ID VisionDesk.cmd");
                    string cmdContent = "@echo off\r\nstart \"\" \"" + dstSetup + "\" --info\r\n";
                    File.WriteAllText(cmdPath, cmdContent);
                }
                catch { }

                progressBar.Value = 60;
                lblStatus.Text = "Guardando configuración en config.json...";
                Application.DoEvents();

                // Generate config.json
                string jsonConfig = "{\n" +
                    "  \"serverUrl\": \"" + txtServerUrl.Text.Trim().Replace("\\", "\\\\") + "\",\n" +
                    "  \"branchId\": \"" + cmbBranchId.Text.Trim() + "\",\n" +
                    "  \"alias\": \"" + txtAlias.Text.Trim().Replace("\"", "\\\"") + "\",\n" +
                    "  \"masterToken\": \"" + txtMasterToken.Text.Trim().Replace("\"", "\\\"") + "\",\n" +
                    "  \"fixedPassword\": \"" + txtPassword.Text.Trim().Replace("\"", "\\\"") + "\",\n" +
                    "  \"fps\": 15,\n" +
                    "  \"quality\": 70\n" +
                    "}";

                File.WriteAllText(Path.Combine(targetDir, "config.json"), jsonConfig);

                progressBar.Value = 80;
                lblStatus.Text = "Configurando inicio automático con Windows...";
                Application.DoEvents();

                if (chkAutoStart.Checked)
                {
                    try
                    {
                        // Registry Auto-run in CurrentUser
                        RegistryKey rk = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run", true);
                        if (rk != null)
                        {
                            rk.SetValue("VisionDeskAgent", "\"" + dstExe + "\"");
                            rk.Close();
                        }
                    }
                    catch (Exception ex)
                    {
                        Console.WriteLine("Warning setting registry run: " + ex.Message);
                    }
                }

                progressBar.Value = 95;
                if (chkStartNow.Checked && File.Exists(dstExe))
                {
                    lblStatus.Text = "Iniciando servicio VisionDesk en segundo plano...";
                    Application.DoEvents();
                    try
                    {
                        ProcessStartInfo psi = new ProcessStartInfo();
                        psi.FileName = dstExe;
                        psi.WorkingDirectory = targetDir;
                        psi.WindowStyle = ProcessWindowStyle.Hidden;
                        psi.CreateNoWindow = true;
                        Process.Start(psi);
                    }
                    catch { }
                }

                progressBar.Value = 100;
                lblStatus.Text = "Instalación completada.";
                Application.DoEvents();

                lblFinishedDesc.Text = "El agente VisionDesk ha sido instalado en: " + targetDir + "\n\n" +
                                       "• Servidor enlazado: " + txtServerUrl.Text + "\n" +
                                       "• Sucursal: " + cmbBranchId.Text + " (" + txtAlias.Text + ")\n" +
                                       "• Inicio automático: " + (chkAutoStart.Checked ? "Activado con Windows" : "Manual") + "\n\n" +
                                       "La máquina ya está transmitiendo al Panel Central.\n\n" +
                                       "Haga clic en 'Finalizar' para cerrar el instalador.";

                btnNext.Enabled = true;
                ShowStep(4);
            }
            catch (Exception ex)
            {
                MessageBox.Show("Error durante la instalación:\n" + ex.Message, "Error de Instalación", MessageBoxButtons.OK, MessageBoxIcon.Error);
                btnNext.Enabled = true;
                btnBack.Enabled = true;
                btnCancel.Enabled = true;
            }
        }
    }

    public class CredentialsForm : Form
    {
        private string machineIdFormatted = "--- --- ---";
        private string branchId = "computo";
        private string alias = "SOPORTE-TECNICO";
        private string fixedPassword = "Odisea_11$";
        private string serverUrl = "https://desk.manzanares.pe";
        private bool isPasswordVisible = false;
        private Label lblPwdValue;
        private Button btnToggleEye;

        public CredentialsForm()
        {
            LoadConfigAndId();
            InitializeComponent();
        }

        private void LoadConfigAndId()
        {
            try
            {
                string rawGuid = GetMachineGuid();
                string id9 = Generate9DigitId(rawGuid);
                machineIdFormatted = FormatTriplets(id9);

                string cfgPath = @"C:\VisionDesk\config.json";
                if (!File.Exists(cfgPath))
                {
                    cfgPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "config.json");
                }
                if (File.Exists(cfgPath))
                {
                    string json = File.ReadAllText(cfgPath);
                    string b = ExtractJsonString(json, "branchId");
                    if (!string.IsNullOrEmpty(b)) branchId = b;
                    string a = ExtractJsonString(json, "alias");
                    if (!string.IsNullOrEmpty(a)) alias = a;
                    string p = ExtractJsonString(json, "fixedPassword");
                    if (!string.IsNullOrEmpty(p)) fixedPassword = p;
                    string s = ExtractJsonString(json, "serverUrl");
                    if (!string.IsNullOrEmpty(s)) serverUrl = s.Replace("wss://", "https://").Replace("ws://", "http://").Replace("/ws", "");
                }
            }
            catch { }
        }

        private static string GetMachineGuid()
        {
            try
            {
                using (RegistryKey baseKey = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64))
                using (RegistryKey subKey = baseKey.OpenSubKey(@"SOFTWARE\Microsoft\Cryptography"))
                {
                    if (subKey != null)
                    {
                        object val = subKey.GetValue("MachineGuid");
                        if (val != null) return val.ToString();
                    }
                }
            }
            catch { }
            return Environment.MachineName;
        }

        private static string Generate9DigitId(string guid)
        {
            using (SHA256 sha = SHA256.Create())
            {
                byte[] bytes = Encoding.UTF8.GetBytes(guid.ToLowerInvariant());
                byte[] hash = sha.ComputeHash(bytes);
                ulong uval = BitConverter.ToUInt64(hash, 0);
                ulong idNum = 100000000UL + (uval % 900000000UL);
                return idNum.ToString();
            }
        }

        private static string FormatTriplets(string raw9)
        {
            if (raw9 != null && raw9.Length == 9)
                return raw9.Substring(0, 3) + " " + raw9.Substring(3, 3) + " " + raw9.Substring(6, 3);
            return raw9;
        }

        internal static string ExtractJsonString(string json, string key)
        {
            System.Text.RegularExpressions.Match match = System.Text.RegularExpressions.Regex.Match(
                json, "\"" + System.Text.RegularExpressions.Regex.Escape(key) + "\"\\s*:\\s*\"([^\"]*)\"");
            return match.Success ? match.Groups[1].Value : null;
        }

        private void InitializeComponent()
        {
            this.Text = "VisionDesk - Mis Credenciales de Estación";
            this.Size = new Size(460, 420);
            this.StartPosition = FormStartPosition.CenterScreen;
            this.FormBorderStyle = FormBorderStyle.FixedDialog;
            this.MaximizeBox = false;
            this.MinimizeBox = false;
            this.BackColor = Color.FromArgb(17, 24, 39); // Slate-900
            this.Font = new Font("Segoe UI", 9F, FontStyle.Regular, GraphicsUnit.Point);

            // Header Banner
            Panel topPanel = new Panel();
            topPanel.Dock = DockStyle.Top;
            topPanel.Height = 70;
            topPanel.BackColor = Color.FromArgb(30, 41, 59);

            Label lblTitle = new Label();
            lblTitle.Text = "Tu Computadora: " + alias;
            lblTitle.Font = new Font("Segoe UI", 12F, FontStyle.Bold);
            lblTitle.ForeColor = Color.White;
            lblTitle.Location = new Point(18, 14);
            lblTitle.AutoSize = true;

            Label lblSub = new Label();
            lblSub.Text = "Comparte estos datos con la persona que te va a ayudar:";
            lblSub.ForeColor = Color.FromArgb(156, 163, 175);
            lblSub.Location = new Point(20, 40);
            lblSub.AutoSize = true;

            topPanel.Controls.Add(lblTitle);
            topPanel.Controls.Add(lblSub);

            // Card Panel
            Panel cardPanel = new Panel();
            cardPanel.Location = new Point(20, 85);
            cardPanel.Size = new Size(405, 175);
            cardPanel.BackColor = Color.FromArgb(15, 23, 42);
            cardPanel.BorderStyle = BorderStyle.FixedSingle;

            // ID Field
            Label lblIdLabel = new Label();
            lblIdLabel.Text = "TU IDENTIFICADOR (ID):";
            lblIdLabel.Font = new Font("Segoe UI", 8.5F, FontStyle.Bold);
            lblIdLabel.ForeColor = Color.FromArgb(148, 163, 184);
            lblIdLabel.Location = new Point(16, 14);
            lblIdLabel.AutoSize = true;

            Label lblIdValue = new Label();
            lblIdValue.Text = machineIdFormatted;
            lblIdValue.Font = new Font("Consolas", 18F, FontStyle.Bold);
            lblIdValue.ForeColor = Color.FromArgb(96, 165, 250); // Blue-400
            lblIdValue.Location = new Point(16, 34);
            lblIdValue.AutoSize = true;

            // Password Field
            Label lblPwdLabel = new Label();
            lblPwdLabel.Text = "CONTRASEÑA DE ACCESO:";
            lblPwdLabel.Font = new Font("Segoe UI", 8.5F, FontStyle.Bold);
            lblPwdLabel.ForeColor = Color.FromArgb(148, 163, 184);
            lblPwdLabel.Location = new Point(16, 85);
            lblPwdLabel.AutoSize = true;

            lblPwdValue = new Label();
            lblPwdValue.Text = "••••••••";
            lblPwdValue.Font = new Font("Consolas", 14F, FontStyle.Bold);
            lblPwdValue.ForeColor = Color.White;
            lblPwdValue.Location = new Point(16, 108);
            lblPwdValue.AutoSize = true;

            btnToggleEye = new Button();
            btnToggleEye.Text = "👁️";
            btnToggleEye.Size = new Size(35, 26);
            btnToggleEye.Location = new Point(220, 108);
            btnToggleEye.BackColor = Color.FromArgb(51, 65, 85);
            btnToggleEye.ForeColor = Color.White;
            btnToggleEye.FlatStyle = FlatStyle.Flat;
            btnToggleEye.Click += (s, e) => {
                isPasswordVisible = !isPasswordVisible;
                lblPwdValue.Text = isPasswordVisible ? fixedPassword : "••••••••";
                btnToggleEye.Text = isPasswordVisible ? "🙈" : "👁️";
            };

            cardPanel.Controls.Add(lblIdLabel);
            cardPanel.Controls.Add(lblIdValue);
            cardPanel.Controls.Add(lblPwdLabel);
            cardPanel.Controls.Add(lblPwdValue);
            cardPanel.Controls.Add(btnToggleEye);

            // Copy Big Button
            Button btnCopy = new Button();
            btnCopy.Text = "📢 Copiar Invitación Completa (WhatsApp / Chat)";
            btnCopy.Size = new Size(405, 42);
            btnCopy.Location = new Point(20, 275);
            btnCopy.BackColor = Color.FromArgb(37, 99, 235);
            btnCopy.ForeColor = Color.White;
            btnCopy.Font = new Font("Segoe UI", 10F, FontStyle.Bold);
            btnCopy.FlatStyle = FlatStyle.Flat;
            btnCopy.Click += (s, e) => {
                string msg = string.Format("Para conectarte a mi PC con VisionDesk:\r\nID: {0}\r\nContraseña: {1}\r\nPanel Web: {2}", machineIdFormatted, fixedPassword, serverUrl);
                Clipboard.SetText(msg);
                MessageBox.Show("¡Datos copiados al portapapeles!\r\nPéguelos en WhatsApp o Teams para compartirlos.", "VisionDesk", MessageBoxButtons.OK, MessageBoxIcon.Information);
            };

            // Bottom Buttons
            Button btnWeb = new Button();
            btnWeb.Text = "🌐 Abrir Panel Web";
            btnWeb.Size = new Size(195, 32);
            btnWeb.Location = new Point(20, 328);
            btnWeb.BackColor = Color.FromArgb(51, 65, 85);
            btnWeb.ForeColor = Color.White;
            btnWeb.FlatStyle = FlatStyle.Flat;
            btnWeb.Click += (s, e) => {
                try { Process.Start(serverUrl); } catch { }
            };

            Button btnClose = new Button();
            btnClose.Text = "Cerrar";
            btnClose.Size = new Size(195, 32);
            btnClose.Location = new Point(230, 328);
            btnClose.BackColor = Color.FromArgb(51, 65, 85);
            btnClose.ForeColor = Color.White;
            btnClose.FlatStyle = FlatStyle.Flat;
            btnClose.Click += (s, e) => { this.Close(); };

            this.Controls.Add(topPanel);
            this.Controls.Add(cardPanel);
            this.Controls.Add(btnCopy);
            this.Controls.Add(btnWeb);
            this.Controls.Add(btnClose);
        }
    }
}
