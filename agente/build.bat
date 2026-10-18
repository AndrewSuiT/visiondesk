@echo off
setlocal
cd /d "%~dp0"

echo =====================================================================
echo       VisionDesk - Native Windows Background Agent Compiler
echo       Transport: WebRTC P2P Direct UDP + TURN + WebSocket Fallback
echo =====================================================================
echo.

set "CSC_EXE=%SystemRoot%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not exist "%CSC_EXE%" (
    set "CSC_EXE=%SystemRoot%\Microsoft.NET\Framework\v4.0.30319\csc.exe"
)

if not exist "%CSC_EXE%" (
    echo [ERROR] csc.exe compiler not found in .NET Framework directory.
    exit /b 1
)

echo [OK] Compiler located: %CSC_EXE%

if not exist "lib\SIPSorcery.dll" (
    echo [WARN] WebRTC runtime libraries not found in lib\. Restoring...
    if exist "nuget.exe" (
        nuget.exe install SIPSorcery -Version 10.0.17 -OutputDirectory "packages"
    )
)

echo [BUILDING] Compiling VisionDeskAgent.exe with WebRTC Dual Transport...

"%CSC_EXE%" /target:winexe /optimize+ /platform:anycpu /lib:lib /r:lib\SIPSorcery.dll /r:lib\SIPSorceryMedia.Abstractions.dll /r:lib\DnsClient.dll /r:lib\BouncyCastle.Cryptography.dll /r:lib\System.Memory.dll /r:lib\System.Threading.Tasks.Extensions.dll /r:lib\Microsoft.Bcl.AsyncInterfaces.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll /out:VisionDeskAgent.exe Program.cs ScreenCapturer.cs InputInjector.cs AuthDialog.cs WebRtcManager.cs

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] Agent compilation failed with error code %ERRORLEVEL%.
    exit /b %ERRORLEVEL%
)

echo [BUILDING] Compiling VisionDeskSetup.exe (Wizard Installer)...
"%CSC_EXE%" /target:winexe /optimize+ /platform:anycpu /r:System.Drawing.dll /r:System.Windows.Forms.dll /out:VisionDeskSetup.exe VisionDeskSetup.cs

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] Setup compilation failed with error code %ERRORLEVEL%.
    exit /b %ERRORLEVEL%
)

echo.
echo [SUCCESS] VisionDeskAgent.exe and VisionDeskSetup.exe compiled successfully.
if exist "VisionDeskAgent.exe" (
    for %%I in ("VisionDeskAgent.exe") do echo [INFO] Agent Binary Size: %%~zI bytes
)
if exist "VisionDeskSetup.exe" (
    for %%I in ("VisionDeskSetup.exe") do echo [INFO] Setup Binary Size: %%~zI bytes
)

echo.
echo [PACKAGING] Packaging VisionDesk-Agent.zip for server direct download...
set "DOWNLOADS_DIR=..\server\public\downloads"
if not exist "%DOWNLOADS_DIR%" mkdir "%DOWNLOADS_DIR%"

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$t = Join-Path $env:TEMP ('vd_pkg_' + [Guid]::NewGuid().ToString('N'));" ^
  "New-Item -ItemType Directory -Force -Path $t | Out-Null;" ^
  "Copy-Item 'VisionDeskAgent.exe', 'VisionDeskSetup.exe', 'instalar_agente.bat', 'LEEME.txt' $t -Force;" ^
  "Copy-Item 'lib' $t -Recurse -Force;" ^
  "$z = '..\server\public\downloads\VisionDesk-Agent.zip';" ^
  "if (Test-Path $z) { Remove-Item $z -Force };" ^
  "Compress-Archive -Path (Get-ChildItem -Path $t).FullName -DestinationPath $z -CompressionLevel Optimal;" ^
  "Remove-Item $t -Recurse -Force;" ^
  "$len = (Get-Item $z).Length;" ^
  "Write-Output ('[SUCCESS] VisionDesk-Agent.zip ready in server/public/downloads (' + [math]::Round($len / 1MB, 2) + ' MB)');"

exit /b 0

