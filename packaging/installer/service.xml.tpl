<!-- Integration Hub — Windows service definition (W2.5). Rendered by
     build.sh with the picked ports; consumed by the WinSW shim
     (IntegrationHub.exe = WinSW-x64.exe renamed). WinSW serves the SCM
     control protocol — the reason a bare `sc.exe binPath=node.exe` service
     dies with error 1053 — while supervision semantics stay in
     HubSupervisor (the OS keeps exactly ONE process alive). -->
<service>
  <id>integration-hub</id>
  <name>Integration Hub (local)</name>
  <description>Healthcare device integration hub — local edge service</description>
  <env name="NODE_ENV" value="production"/>
  <env name="HUB_DATA_DIR" value="%ProgramData%\IntegrationHub"/>
  <env name="PORT" value="__HTTP_PORT__"/>
  <env name="DEVICE_PORT" value="__DEVICE_PORT__"/>
  <!-- W2 first-boot setup: auto-on for the SQLite local edge -->
  <env name="HUB_LOCAL_SETUP" value="1"/>
  <executable>%BASE%\node.exe</executable>
  <arguments>--import tsx %BASE%\app\packages\server\src\service-cli.ts</arguments>
  <workingdirectory>%BASE%\app</workingdirectory>
  <startmode>Automatic</startmode>
  <onfailure action="restart" delay="5 sec"/>
  <onfailure action="restart" delay="10 sec"/>
  <onfailure action="restart" delay="30 sec"/>
  <resetfailure>86400</resetfailure>
  <stoptimeout>20 sec</stoptimeout>
  <stopparentprocessfirst>false</stopparentprocessfirst>
  <log mode="roll-by-size">
    <logpath>%ProgramData%\IntegrationHub\logs</logpath>
    <sizeThreshold>10240</sizeThreshold>
    <keepFiles>8</keepFiles>
  </log>
</service>
