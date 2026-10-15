@echo off
cd /d "%~dp0"
set /p INPUT=Input video path:
set /p MODULES=Modules separated by ^|, example: ?Hook^|?AI Brain^|?Brand Follow-up:
set /p CURRENT=Current module number, example 1:
python-3.11.9-embed-amd64\python.exe tools\render_segment.py --clip "%INPUT%" --output "%~dp0progress_output.mp4" --modules "%MODULES%" --current "%CURRENT%" --no-voiceover --no-subtitles --duration 10
pause
