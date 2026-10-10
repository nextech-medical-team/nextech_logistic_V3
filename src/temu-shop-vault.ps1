param([Parameter(Mandatory=$true)][string]$Directory)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
$rsa=New-Object System.Security.Cryptography.RSACryptoServiceProvider
$rsa.PersistKeyInCsp=$false
try {
 $rsa.ImportCspBlob([System.Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes((Join-Path $Directory 'shops-key.dpapi')),$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser))
 $items=Get-Content -LiteralPath (Join-Path $Directory 'shops-encrypted.json') -Raw | ConvertFrom-Json
 $result=@(foreach($item in $items){$clear=[Text.Encoding]::UTF8.GetString($rsa.Decrypt([Convert]::FromBase64String($item.cipher),$true)) | ConvertFrom-Json; @{country=$item.country;appKey=$clear.appKey;appSecret=$clear.appSecret;accessToken=$clear.accessToken}})
 ConvertTo-Json -InputObject $result -Compress
}finally{$rsa.Dispose()}
