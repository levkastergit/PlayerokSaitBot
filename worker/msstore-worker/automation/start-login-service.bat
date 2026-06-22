@echo off
REM ============================================================================
REM  login_service на ЭТОЙ машине (сервер 2, 4 ядра/8ГБ) — браузерный вход покупателей.
REM  Backend на VPS ходит сюда: http://82.23.163.205:8765
REM  Защита: shared-secret токен (X-Login-Token) + Windows-фаервол пускает ТОЛЬКО IP VPS.
REM  Токен берётся из %USERPROFILE%\login_service.token .
REM  Окно НЕ закрывать — это и есть сам сервис (тут видны логи входов).
REM  Автозапуск при входе в систему: положи ярлык на этот .bat в shell:startup .
REM ============================================================================
set /p LOGIN_SERVICE_TOKEN=<"%USERPROFILE%\login_service.token"
cd /d "C:\playerok\worker\msstore-worker\automation"
echo [login_service] запускаю на 0.0.0.0:8765 (токен-защита включена, фаервол = только VPS)...
echo [login_service] логи пишутся в %~dp0login_service.log
python login_service.py --host 0.0.0.0 --port 8765 >> "%~dp0login_service.log" 2>&1
echo.
echo [login_service] процесс завершился. Код: %ERRORLEVEL%
pause
