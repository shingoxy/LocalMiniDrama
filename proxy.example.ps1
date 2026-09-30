# Copy to .local/proxy.ps1, then edit for YOUR existing HTTP proxy.
# These variables apply only to processes launched by run_dev.bat.
# $env:HTTP_PROXY = 'http://127.0.0.1:YOUR_PORT'
# $env:HTTPS_PROXY = 'http://127.0.0.1:YOUR_PORT'
$env:NO_PROXY = 'localhost,127.0.0.1,::1,.aliyuncs.com,.volces.com,.volcengineapi.com,.klingai.com,.vidu.cn'
