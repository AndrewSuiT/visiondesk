@echo off
setlocal EnableDelayedExpansion
title VisionDesk PRO - Instalador Inteligente

:: 1. Comprobacion y elevacion automatica a Administrador
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo [INFO] Solicitando permisos de Administrador...
    powershell -NoProfile -Command "Start-Process cmd -ArgumentList '/c \"\"%~f0\"\"' -Verb RunAs"
    exit /b
)

cd /d "%~dp0"

echo =======================================================================
echo          VisionDesk PRO - Instalador Inteligente de Estacion
echo          Supervision y Soporte Remoto (Manzanares S.A.C.)
echo =======================================================================
echo.

set "INSTALL_DIR=C:\VisionDesk"
set "CONFIG_FILE=%INSTALL_DIR%\config.json"

:: 2. Desbloquear archivos descargados (eliminar Advertencia de seguridad / Zone.Identifier)
echo [SEGURIDAD] Desbloqueando archivos de la web para ejecucion silenciosa...
powershell -NoProfile -Command "Get-ChildItem -Path '%~dp0' -Recurse -ErrorAction SilentlyContinue | Unblock-File; if (Test-Path '%INSTALL_DIR%') { Get-ChildItem -Path '%INSTALL_DIR%' -Recurse -ErrorAction SilentlyContinue | Unblock-File }" >nul 2>&1

if exist "%CONFIG_FILE%" (
    goto :ACTUALIZAR
) else (
    goto :INSTALAR_NUEVO
)

:ACTUALIZAR
echo [DETECCION] Se encontro una instalacion existente en %INSTALL_DIR%.
echo [INFO] Preservando archivo de configuracion (cuenta, sucursal, alias y clave)...
echo.
echo 1. Cerrando instancias previas de VisionDesk...
taskkill /f /im VisionDeskAgent.exe /im VisionDeskSetup.exe >nul 2>&1
timeout /t 1 /nobreak >nul

echo 2. Actualizando binarios principales...
if exist "VisionDeskAgent.exe" copy /y "VisionDeskAgent.exe" "%INSTALL_DIR%\" >nul
if exist "VisionDeskSetup.exe" copy /y "VisionDeskSetup.exe" "%INSTALL_DIR%\" >nul

echo 3. Actualizando bibliotecas WebRTC P2P (lib)...
if not exist "%INSTALL_DIR%\lib" mkdir "%INSTALL_DIR%\lib"
if exist "lib\*" copy /y "lib\*" "%INSTALL_DIR%\lib\" >nul

echo 4. Eliminando restricciones de seguridad de Windows...
powershell -NoProfile -Command "Get-ChildItem -Path '%INSTALL_DIR%' -Recurse -ErrorAction SilentlyContinue | Unblock-File" >nul 2>&1

echo 5. Asegurando inicio automatico con Windows...
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v "VisionDeskAgent" /t REG_SZ /d "\"%INSTALL_DIR%\VisionDeskAgent.exe\"" /f >nul 2>&1

echo 6. Reiniciando VisionDesk Agent en segundo plano...
:: Cambiar al directorio permanente de destino antes de arrancar para no bloquear la carpeta temporal
cd /d "%INSTALL_DIR%"
start "" /d "%INSTALL_DIR%" "%INSTALL_DIR%\VisionDeskAgent.exe"

echo.
echo =======================================================================
echo  [EXITO] La estacion se ha actualizado correctamente.
echo  El agente ya esta funcionando en segundo plano (silencioso).
echo  Ya puede borrar o cerrar esta carpeta sin problemas.
echo =======================================================================
echo.
timeout /t 3
exit /b 0

:INSTALAR_NUEVO
echo [DETECCION] No se encontro instalacion previa. Iniciando primera instalacion...
echo.
echo 1. Preparando directorio %INSTALL_DIR%...
if not exist "%INSTALL_DIR%" mkdir "%INSTALL_DIR%"
if not exist "%INSTALL_DIR%\lib" mkdir "%INSTALL_DIR%\lib"

echo 2. Copiando archivos de la aplicacion...
if exist "VisionDeskAgent.exe" copy /y "VisionDeskAgent.exe" "%INSTALL_DIR%\" >nul
if exist "VisionDeskSetup.exe" copy /y "VisionDeskSetup.exe" "%INSTALL_DIR%\" >nul
if exist "lib\*" copy /y "lib\*" "%INSTALL_DIR%\lib\" >nul

echo 3. Eliminando restricciones de seguridad de Windows...
powershell -NoProfile -Command "Get-ChildItem -Path '%INSTALL_DIR%' -Recurse -ErrorAction SilentlyContinue | Unblock-File" >nul 2>&1

echo 4. Iniciando asistente de configuracion inicial...
echo    (Ingrese la Sucursal, Nombre del equipo y Clave de acceso en la ventana)
echo.
cd /d "%INSTALL_DIR%"
start "" /d "%INSTALL_DIR%" "%INSTALL_DIR%\VisionDeskSetup.exe"
exit /b 0
