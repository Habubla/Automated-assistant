param([switch]$Verify)
$ErrorActionPreference='Stop'
$project=Split-Path -Parent $PSScriptRoot
$widgetMutex=New-Object Threading.Mutex($false,'Local\JuneTaskWidget')
if(-not $widgetMutex.WaitOne(0)){exit 0}
Add-Type -AssemblyName PresentationFramework,PresentationCore,WindowsBase,System.Windows.Forms,System.Drawing
[xml]$xaml=@'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml" Title="June Tasks" Width="390" Height="640" MinWidth="340" MinHeight="400" WindowStartupLocation="Manual" Background="#F5F6F0" FontFamily="Segoe UI" Foreground="#283B32">
 <Grid Margin="18"><Grid.RowDefinitions><RowDefinition Height="Auto"/><RowDefinition Height="Auto"/><RowDefinition Height="*"/><RowDefinition Height="Auto"/><RowDefinition Height="Auto"/></Grid.RowDefinitions>
 <DockPanel><TextBlock Text="June.  Your next steps" FontSize="21" FontWeight="SemiBold"/><CheckBox Name="Pin" Content="Pin" HorizontalAlignment="Right" Margin="10,6,0,0"/></DockPanel>
 <TextBlock Name="Status" Grid.Row="1" Text="Connecting to June..." TextWrapping="Wrap" Margin="0,12,0,12" Foreground="#687867"/>
 <ListBox Name="Tasks" Grid.Row="2" BorderThickness="0" Background="#FFFDF7" HorizontalContentAlignment="Stretch" ScrollViewer.HorizontalScrollBarVisibility="Disabled">
  <ListBox.ItemTemplate><DataTemplate><StackPanel Margin="7,10"><TextBlock Text="{Binding title}" TextWrapping="Wrap" FontWeight="SemiBold"/><TextBlock Text="{Binding DueLabel}" Margin="0,5,0,0" Foreground="#516B4F"/><TextBlock Text="{Binding status}" FontSize="11" Foreground="#7B806E"/></StackPanel></DataTemplate></ListBox.ItemTemplate>
 </ListBox>
 <TextBlock Grid.Row="3" Text="Click a task for its prepared brief. Closing keeps reminders in the tray." FontSize="11" TextWrapping="Wrap" Margin="0,12,0,12"/>
 <StackPanel Grid.Row="4" Orientation="Horizontal"><Button Name="Board" Content="Open task board" Padding="12,7"/><Button Name="Refresh" Content="Refresh" Padding="12,7" Margin="8,0,0,0"/></StackPanel>
 </Grid>
</Window>
'@
$reader=New-Object System.Xml.XmlNodeReader $xaml
$window=[Windows.Markup.XamlReader]::Load($reader)
$taskList=$window.FindName('Tasks');$status=$window.FindName('Status')
$work=[System.Windows.SystemParameters]::WorkArea
$window.Left=[math]::Max(0,$work.Right-$window.Width-20);$window.Top=$work.Top+35
$tray=New-Object System.Windows.Forms.NotifyIcon
$tray.Icon=[System.Drawing.SystemIcons]::Information;$tray.Text='June tasks and reminders';$tray.Visible=$true
$script:lastTask=$null;$script:seen=@{};$script:allowClose=$false
function Invoke-June([string]$Route,[object]$Body=$null){
 $access=Get-Content -LiteralPath (Join-Path $project '.local\hub\access.json') -Raw|ConvertFrom-Json
 $session=New-Object Microsoft.PowerShell.Commands.WebRequestSession
 $session.Cookies.Add((New-Object System.Net.Cookie('june_session',$access.token,'/','127.0.0.1')))
 $headers=@{'X-June-Action'='1';Origin='http://127.0.0.1:3211'}
 if($null -eq $Body){return Invoke-RestMethod -Uri ('http://127.0.0.1:3211'+$Route) -WebSession $session -Headers $headers -TimeoutSec 5}
 Invoke-RestMethod -Uri ('http://127.0.0.1:3211'+$Route) -Method Post -ContentType 'application/json' -Body ($Body|ConvertTo-Json -Compress) -WebSession $session -Headers $headers -TimeoutSec 5
}
function Open-JuneTask([string]$TaskId=''){
 $access=Get-Content -LiteralPath (Join-Path $project '.local\hub\access.json') -Raw|ConvertFrom-Json
 $query=if($TaskId){'?id='+[Uri]::EscapeDataString($TaskId)}else{''}
 Start-Process ('http://127.0.0.1:3211/tasks'+$query+'#token='+$access.token)
}
function Refresh-JuneWidget {
 $stage='request'
 try{
  $data=Invoke-June '/api/tasks'
  $stage='render'
  $rows=@($data.tasks|Where-Object {-not $_.due_at -or ([datetime]$_.due_at) -gt (Get-Date).AddDays(-7)}|Sort-Object @{Expression={if(-not $_.due_at){2}elseif(([datetime]$_.due_at) -ge (Get-Date)){0}else{1}}},@{Expression={if($_.due_at){[math]::Abs((([datetime]$_.due_at)-(Get-Date)).TotalSeconds)}else{[double]::MaxValue}}}|Select-Object -First 30)
  $zone=[TimeZoneInfo]::FindSystemTimeZoneById('India Standard Time')
  foreach($task in $rows){
   $label=if($task.due_at){[TimeZoneInfo]::ConvertTimeFromUtc(([datetime]$task.due_at).ToUniversalTime(),$zone).ToString('ddd, d MMM - h:mm tt')+' IST'}else{'Needs a due date'}
   $task|Add-Member -NotePropertyName DueLabel -NotePropertyValue $label -Force
  }
  $taskList.ItemsSource=$rows
  $status.Text=([string]$data.tasks.Count)+' open tasks. Updated '+(Get-Date).ToString('h:mm tt')
  $alert=@($data.notifications|Where-Object {-not $_.delivered_at -and -not $script:seen.ContainsKey($_.id)})
  $stage='reminders'
  if($alert.Count -gt 0 -and -not $Verify){
   $r=$alert[0];$script:lastTask=if($alert.Count -eq 1){$r.task_id}else{''}
   $tray.BalloonTipTitle=if($alert.Count -gt 1){'June - deadline reminders'}elseif($r.status -eq 'detected'){'June - detected deadline'}else{'June reminder'}
   $tray.BalloonTipText=if($alert.Count -gt 1){([string]$alert.Count)+' tasks need attention. Click to review their dates and prepared briefs.'}else{$r.title.Substring(0,[math]::Min(180,$r.title.Length))+' - due '+[TimeZoneInfo]::ConvertTimeFromUtc(([datetime]$r.due_at).ToUniversalTime(),$zone).ToString('d MMM, h:mm tt')+' IST'}
   $tray.ShowBalloonTip(10000)
   foreach($reminder in $alert){$script:seen[$reminder.id]=$true;Invoke-June '/api/tasks/reminder' @{id=$reminder.id;delivered=$true}|Out-Null}
  }
  [pscustomobject]@{connected=$true;polledAt=(Get-Date).ToUniversalTime().ToString('o');visibleTasks=$rows.Count;notificationsRequested=$script:seen.Count}|ConvertTo-Json -Compress|Set-Content -LiteralPath (Join-Path $project '.local\runtime\widget-status.json')
 }catch{
  $status.Text='June is starting or offline. Waiting to reconnect...'
  [pscustomobject]@{connected=$false;polledAt=(Get-Date).ToUniversalTime().ToString('o');stage=$stage;errorType=$_.Exception.GetType().FullName}|ConvertTo-Json -Compress|Set-Content -LiteralPath (Join-Path $project '.local\runtime\widget-status.json')
 }
}
$window.FindName('Pin').Add_Checked({$window.Topmost=$true});$window.FindName('Pin').Add_Unchecked({$window.Topmost=$false})
$window.FindName('Board').Add_Click({Open-JuneTask})
$window.FindName('Refresh').Add_Click({Refresh-JuneWidget})
$taskList.Add_SelectionChanged({if($taskList.SelectedItem){Open-JuneTask $taskList.SelectedItem.id;$taskList.SelectedIndex=-1}})
$tray.Add_DoubleClick({$window.Show();$window.Activate()|Out-Null})
$tray.Add_BalloonTipClicked({Open-JuneTask $script:lastTask})
$menu=New-Object System.Windows.Forms.ContextMenuStrip
$show=$menu.Items.Add('Show June tasks');$show.Add_Click({$window.Show();$window.Activate()|Out-Null})
$exitItem=$menu.Items.Add('Close widget and reminders');$exitItem.Add_Click({$script:allowClose=$true;$window.Close()})
$tray.ContextMenuStrip=$menu
$window.Add_Closing({param($sender,$e)if(-not $script:allowClose){$e.Cancel=$true;$window.Hide()}})
$timer=New-Object Windows.Threading.DispatcherTimer
$timer.Interval=[TimeSpan]::FromSeconds(15);$timer.Add_Tick({Refresh-JuneWidget});$timer.Start()
try{
 Refresh-JuneWidget
 if($Verify){
  [pscustomobject]@{ok=$true;items=$taskList.Items.Count;connected=($status.Text -notlike '*offline*')}|ConvertTo-Json
 }else{[void]$window.ShowDialog()}
}finally{$timer.Stop();$tray.Dispose();$widgetMutex.ReleaseMutex();$widgetMutex.Dispose()}
