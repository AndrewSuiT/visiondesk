@echo off
setlocal
cd /d "%~dp0"

echo =====================================================================
echo       VisionDesk - Herramienta de Empaquetado de Distribucion
echo =====================================================================
echo.

:: 1. Verificar artefactos requeridos
if not exist "%~dp0VisionDeskAgent.exe" (
    echo [ERROR] VisionDeskAgent.exe no encontrado en %~dp0. Ejecute build.bat primero.
    exit /b 1
)
if not exist "%~dp0VisionDeskSetup.exe" (
    echo [ERROR] VisionDeskSetup.exe no encontrado en %~dp0. Ejecute build.bat primero.
    exit /b 1
)
if not exist "%~dp0actualizar_agente.bat" (
    echo [ERROR] actualizar_agente.bat no encontrado en %~dp0.
    exit /b 1
)
if not exist "%~dp0lib\SIPSorcery.dll" (
    echo [ERROR] lib\SIPSorcery.dll no encontrado en %~dp0lib.
    exit /b 1
)

if "%~1"=="" (
    set "ZIP_OUT=%~dp0..\VisionDeskAgent_v1.0.4.zip"
) else (
    set "ZIP_OUT=%~f1"
)

echo [EMPAQUETANDO] Generando paquete ZIP de distribucion: %ZIP_OUT%...

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$ErrorActionPreference = 'Stop';" ^
    "$stage = Join-Path $env:TEMP ('vd_pkg_' + [Guid]::NewGuid().ToString('N'));" ^
    "New-Item -ItemType Directory -Path $stage | Out-Null;" ^
    "Copy-Item '%~dp0VisionDeskAgent.exe' -Destination $stage;" ^
    "Copy-Item '%~dp0VisionDeskSetup.exe' -Destination $stage;" ^
    "Copy-Item '%~dp0actualizar_agente.bat' -Destination $stage;" ^
    "Copy-Item '%~dp0lib' -Destination $stage -Recurse;" ^
    "$outZip = [System.IO.Path]::GetFullPath('%ZIP_OUT%');" ^
    "if (Test-Path $outZip) { Remove-Item $outZip -Force };" ^
    "Add-Type -AssemblyName System.IO.Compression.FileSystem;" ^
    "[System.IO.Compression.ZipFile]::CreateFromDirectory($stage, $outZip);" ^
    "Remove-Item $stage -Recurse -Force;"

if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Fallo el empaquetado con codigo %ERRORLEVEL%.
    exit /b %ERRORLEVEL%
)

echo.
echo [EXITO] Paquete generado exitosamente: %ZIP_OUT%
for %%I in ("%ZIP_OUT%") do echo [INFO] Tamano del paquete: %%~zI bytes
exit /b 0
