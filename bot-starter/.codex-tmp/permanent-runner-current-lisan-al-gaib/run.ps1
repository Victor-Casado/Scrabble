$ErrorActionPreference = 'Stop'
Set-Location 'C:\Users\victo\Projects\Personal\scrabblebot\bot-starter'
$env:BOT_NAME = 'lisan al gaib'
$env:STDB_HOST = 'https://maincloud.spacetimedb.com'
$env:STDB_DB = 'scrabblebot'
npm start
