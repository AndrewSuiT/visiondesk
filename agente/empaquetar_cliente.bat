@echo off
setlocal
cd /d "%~dp0"

echo ====================================================
echo    VisionDesk - Generador de Paquete de Distribucion
echo ====================================================
echo.

echo 1. Compilando binarios actualizados...
call build.bat
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] La compilacion fallo. Abortando empaquetado.
    exit /b %ERRORLEVEL%
)

echo.
echo 2. Preparando carpeta de distribucion...
set "DIST=%~dp0..\dist\VisionDesk_Cliente"
if exist "%DIST%" rd /s /q "%DIST%"
mkdir "%DIST%"
mkdir "%DIST%\lib"

echo 3. Copiando ejecutables y scripts...
copy /y "%~dp0VisionDeskAgent.exe" "%DIST%\" >nul
copy /y "%~dp0VisionDeskSetup.exe" "%DIST%\" >nul
copy /y "%~dp0actualizar_agente.bat" "%DIST%\" >nul

echo 4. Copiando todas las librerias WebRTC P2P (lib\)...
xcopy /y /e /i /q "%~dp0lib\*" "%DIST%\lib\" >nul

echo 5. Generando instrucciones de despliegue...
(
    echo VisionDesk - Paquete Cliente de Estacion
    echo ========================================
    echo.
    echo INSTRUCCIONES DE USO EN CUALQUIER PC:
    echo.
    echo 1. Para ACTUALIZAR una estacion ya existente:
    echo    - Simplemente ejecute "actualizar_agente.bat" como Administrador.
    echo    - El script actualizara VisionDeskAgent.exe, VisionDeskSetup.exe y
    echo      todas las librerias WebRTC en C:\VisionDesk\lib.
    echo    - Su nombre de equipo, alias y contrasena se PRESERVARAN intactos.
    echo.
    echo 2. Para INSTALAR en una PC nueva por primera vez:
    echo    - Ejecute "actualizar_agente.bat" o "VisionDeskSetup.exe".
    echo    - Como no detectara una configuracion previa, abrira el asistente
    echo      grafico para ingresar la sucursal, alias y contrasena.
    echo.
    echo NOTA: Mantenga siempre la carpeta "lib" junto a los ejecutables para
    echo       que la conexion directa WebRTC P2P funcione correctamente.
) > "%DIST%\LEAME_INSTRUCCIONES.txt"

echo.
echo 6. Creando archivo comprimido ZIP para facil envio...
set "ZIP_OUT=%~dp0..\dist\VisionDesk_Cliente.zip"
if exist "%ZIP_OUT%" del /f /q "%ZIP_OUT%"

powershell -Command "Compress-Archive -Path '%DIST%\*' -DestinationPath '%ZIP_OUT%' -Force"

echo.
echo ====================================================
echo  [EXITO] Paquete cliente generado exitosamente!
echo  Carpeta : %DIST%
echo  Archivo : %ZIP_OUT%
echo ====================================================
echo.
exit /b 0
