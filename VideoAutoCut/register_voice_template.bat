@echo off
cd /d "%~dp0"
echo.
echo ========== Register Voice Template ==========
echo Local samples are in:
echo %~dp0voice_templates
echo.
echo This tool can upload a local mp3 to DashScope temporary storage,
echo then create a voice template automatically.
echo.
set /p PREFIX=Voice prefix, English letters and numbers only, default myvoice01:
if "%PREFIX%"=="" set PREFIX=myvoice01
python-3.11.9-embed-amd64\python.exe tools\register_voice_template.py --prefix "%PREFIX%"
echo.
pause
