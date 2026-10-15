@echo off
cd /d "%~dp0"
set /p INPUT=Input video path:
set /p SUBTITLE=Subtitle text:
set /p MODULES=Modules separated by ^|:
set /p CURRENT=Current module number:
set /p VOICE=Voiceover text, leave empty to use subtitle:
python-3.11.9-embed-amd64\python.exe tools\render_segment.py --clip "%INPUT%" --output "%~dp0segment_output.mp4" --subtitle "%SUBTITLE%" --voice-text "%VOICE%" --modules "%MODULES%" --current "%CURRENT%" --duration 10
pause
