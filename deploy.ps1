# deploy.ps1 - 生成 .deploy-cloudflare 发版目录（只做暂存准备，不执行部署）
# 用法:  powershell -ExecutionPolicy Bypass -File .\deploy.ps1
# 之后部署:  npx wrangler pages deploy .deploy-cloudflare --project-name easydrop --branch main --commit-dirty=true
$ErrorActionPreference = 'Stop'
$srcHtml = Join-Path $PSScriptRoot 'easydrop-1.0.html'
if (!(Test-Path $srcHtml)) { throw "缺少源文件: $srcHtml" }
$dst = Join-Path $PSScriptRoot '.deploy-cloudflare'
New-Item -ItemType Directory -Force -Path $dst | Out-Null

# 1) 三个 HTML 副本（easydrop-1.0 为 Petr 主体，另两个为兼容入口）
foreach ($name in @('easydrop-1.0.html', 'easydrop.html', 'index.html')) {
    Copy-Item -Path $srcHtml -Destination (Join-Path $dst $name) -Force
}

# 2) vendor/ 递归拷贝（自托管 tailwind / peerjs / mqtt / 字体）
$srcVendor = Join-Path $PSScriptRoot 'vendor'
if (Test-Path $srcVendor) {
    $dstVendor = Join-Path $dst 'vendor'
    Remove-Item -Path $dstVendor -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force -Path $dstVendor | Out-Null
    Copy-Item -Path (Join-Path $srcVendor '*') -Destination $dstVendor -Recurse -Force
}

# 2b) _worker.js（Pages 高级模式路由：信令/信标 WebSocket + /turn-creds 凭证端点）
$srcWorker = Join-Path $PSScriptRoot 'pages-deploy\_worker.js'
if (Test-Path $srcWorker) {
    Copy-Item -Path $srcWorker -Destination (Join-Path $dst '_worker.js') -Force
}

# 3) 自检：
#    a. 三个副本均为相对路径引用（vendor/...）
#    b. 无第三方 <script>/<link> 外链
$copyNames = @('easydrop-1.0.html', 'easydrop.html', 'index.html')
foreach ($name in $copyNames) {
    $c = Get-Content (Join-Path $dst $name) -Raw
    $vrefCount = ([regex]::Matches($c, 'src="vendor/')).Count
    $extRefs = [regex]::Matches($c, '(src|href)="https?://(?!easydrop-ady\.pages\.dev)')
    Write-Output ("[自检] $name : vendor 相对引用 " + $vrefCount + " 处, 第三方外链 " + $extRefs.Count + " 处")
    if ($extRefs.Count -gt 0) { $extRefs | ForEach-Object { Write-Output ("  ^ " + $_.Value) } }
}

Write-Output 'deploy.ps1: 发版目录准备完成（.deploy-cloudflare）。部署请另行执行 wrangler。'
