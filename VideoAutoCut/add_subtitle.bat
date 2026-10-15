@echo off
cd /d "%~dp0"
set /p INPUT=Input video path:
set /p TEXT=Subtitle text:
python-3.11.9-embed-amd64\python.exe tools\render_segment.py --clip "%INPUT%" --output "%~dp0subtitle_output.mp4" --subtitle "%TEXT%" --no-voiceover --no-progress --duration 10
pause
