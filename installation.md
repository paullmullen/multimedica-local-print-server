# Multimedica Local Print Server Installation Guide

**Audience:** Technical installer  
**Applies to:** Windows computers that will bridge Multimedica to an ESC/POS network ticket printer  
**Qualified baseline:** Windows 10 or Windows 11, Node.js LTS, Ethernet or Wi-Fi clinic network  
**Last validated:** August 2026

---

## 1. Purpose

This guide describes the supported procedure for installing and validating the Multimedica local print server. The print server receives ticket requests from the Multimedica web application and sends ESC/POS data directly to a network thermal printer on TCP port 9100.

This component is required only when a clinic uses **thermal ticket** printing. Clinics configured for a Windows page printer or **No print** do not need it.

---

## 2. Where the print server fits

The print server is a small Node.js application named `multimedica-local-print-server`. It runs on a Windows computer that must be able to communicate with both:

- the devices using the Multimedica web application; and
- the thermal printer on the clinic network.

The host computer does not have to be the registration computer, but it must remain powered on while thermal tickets are needed. Do not install the print server on the Raspberry Pi scanner appliance.

The two network addresses have different meanings:

| Setting | Example | Meaning |
|---|---|---|
| Print server URL | `http://192.168.2.48:3333` | Windows computer running this application |
| Printer host | `192.168.2.69` | Thermal printer receiving ESC/POS data |
| Printer port | `9100` | Raw TCP print port on the thermal printer |

Do not enter the printer's IP address as the print server URL.

---

## 3. Stop conditions

Stop and investigate if:

- the printer cannot be reached by IP address;
- TCP port 9100 is disabled or blocked;
- the `/health` page does not open from another clinic computer;
- Windows Firewall access was denied and cannot be corrected;
- the Multimedica location record points to a different print-server computer or printer;
- a test ticket contains real patient information.

---

## 4. Required equipment and information

- Windows 10 or Windows 11 computer that can remain on during clinic operation
- Administrator access for software installation and firewall configuration
- Network connection shared with the relevant clinic devices
- ESC/POS-compatible network thermal printer
- Printer IP address and raw TCP port (normally `9100`)
- Multimedica administrator access to update the clinic location's printing settings
- Internet access during initial installation

Reserve the printer IP address and the Windows host IP in DHCP, or assign stable addresses according to the clinic's network policy. A changing address will eventually interrupt printing.

### Installation worksheet

```text
LOCAL PRINT SERVER INSTALLATION WORKSHEET

Windows computer name:
__________________________________________________________

Print-server IPv4 address:
__________________________________________________________

Print-server port (default 3333):
__________________________________________________________

Printer model:
__________________________________________________________

Printer IPv4 address:
__________________________________________________________

Printer port (default 9100):
__________________________________________________________

Location name in Multimedica:
__________________________________________________________
```

---

## 5. Prepare the Windows host

### 5.1 Give the host and printer stable network addresses

Confirm that the Windows computer and printer will retain their IP addresses. Record both addresses in the worksheet.

### 5.2 Install Git for Windows

Download Git for Windows from <https://git-scm.com/download/win> and use the standard installation options. Close and reopen Windows PowerShell, then run:

```powershell
git --version
```

The command must return a version number.

### 5.3 Install Node.js LTS

Download the current Node.js LTS installer from <https://nodejs.org/en/download>. In the installer, retain the normal selections, including:

- Node.js runtime;
- npm package manager;
- Add to PATH.

The optional tools for compiling native modules are not required by this application. Close and reopen Windows PowerShell, then run:

```powershell
node --version
npm --version
```

Both commands must return version numbers.

---

## 6. Test the printer network connection

Replace the example address below with the printer IP from the worksheet.

```powershell
$printerHost = "192.168.2.69"
Test-Connection $printerHost -Count 2
Test-NetConnection $printerHost -Port 9100
```

`TcpTestSucceeded` must be `True`. A successful ping alone is not sufficient; printing uses TCP port 9100.

If the TCP test fails, confirm the printer address, raw-print setting, cabling, VLAN/network access, and port before proceeding.

---

## 7. Install the local print server

### 7.1 Obtain the repository

For a first installation:

```powershell
New-Item -ItemType Directory -Force C:\dev | Out-Null
Set-Location C:\dev
git clone https://github.com/paullmullen/multimedica-local-print-server.git
Set-Location C:\dev\multimedica-local-print-server
```

For an existing installation:

```powershell
Set-Location C:\dev\multimedica-local-print-server
git status --short
git pull --ff-only origin main
```

`git status --short` must produce no output before updating. If it lists files, stop and preserve the local changes for review.

### 7.2 Install dependencies

From the repository root:

```powershell
npm install
```

The repository root contains `server.js`, `package.json`, and the `assets` folder.

### 7.3 Create the `.env` configuration file

Create `.env` in the repository root. It is a plain-text file, not a Word document. The filename begins with a period and has no `.txt` extension.

```powershell
$printerHost = Read-Host "Enter the thermal printer IP address"
$printerPort = Read-Host "Enter the thermal printer port [9100]"
if ([string]::IsNullOrWhiteSpace($printerPort)) { $printerPort = "9100" }

@"
PRINT_SERVER_PORT=3333
PRINTER_HOST=$printerHost
PRINTER_PORT=$printerPort
"@ | Set-Content -Encoding ascii .\.env
```

Verify the file without displaying any credentials (none are expected in this file):

```powershell
Get-Content .\.env
```

The repository excludes `.env` from Git. Do not commit clinic-specific network configuration.

---

## 8. Start and validate the server

### 8.1 Start interactively

```powershell
Set-Location C:\dev\multimedica-local-print-server
npm start
```

Expected output includes the print-server address and the configured printer target. Keep this PowerShell window open during the initial test.

If Windows Firewall asks whether Node.js may communicate on the network, allow access on the clinic's **Private** network. Do not enable unnecessary Public-network access.

### 8.2 Test locally

Open a second PowerShell window:

```powershell
Invoke-RestMethod http://localhost:3333/health
```

Required values include:

```text
ok                      True
printer_host_configured True
printer_port            9100
```

The health check proves that the Node.js server is running and has loaded its configuration. It does not prove that the printer will accept a ticket.

### 8.3 Record the Windows IPv4 address

```powershell
Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object { $_.IPAddress -notlike "127.*" -and $_.AddressState -eq "Preferred" } |
  Select-Object InterfaceAlias, IPAddress
```

Identify the address used on the clinic network and record it as the print-server IPv4 address.

### 8.4 Test from another clinic computer

From another computer on the clinic network, open this URL in a browser, substituting the print-server address:

```text
http://192.168.2.48:3333/health
```

The browser must display a JSON response with `"ok":true`. If the local test works but this remote test fails, correct Windows Firewall, network profile, or network isolation before continuing.

---

## 9. Configure Multimedica

In the Multimedica Admin page, open the applicable location and set:

- **Print format:** Ticket
- **Print server URL:** `http://<print-server-ip>:3333`
- **Ticket printer host:** the printer IP address only
- **Ticket printer port:** `9100`, unless the printer is deliberately configured otherwise

Save the location. Confirm that the previewed print-server URL and printer address match the installation worksheet.

The print-server URL must include `http://` and port `3333`. The printer host must not include `http://`.

---

## 10. Print an acceptance ticket

Do not use a real patient for installation acceptance.

1. In Multimedica, create a temporary test patient using `testing` as **Motivo de visita**.
2. From **Anfitrión**, print the ticket.
3. Confirm that the print-server PowerShell window logs `PRINT REQUEST RECEIVED`.
4. Confirm that the printer produces one complete, cut ticket.
5. Confirm the logo, location, patient name, visit type, QR code, and location message are legible.
6. Scan the printed QR through the normal scanner workflow.
7. Remove the temporary test patient using the approved test-cleanup procedure.

If the browser reports `Failed to fetch`, first open the `/health` URL from that same browser. If health cannot be reached, diagnose the print-server address, port, firewall, and network. If health works but printing fails, inspect the Node.js console and retest TCP port 9100 to the printer.

---

## 11. Configure automatic startup

The server must start after Windows restarts and must not depend on an installer remembering to open PowerShell.

Open **Task Scheduler** and choose **Create Task**:

1. **General:** Name it `Multimedica Local Print Server`; select **Run whether user is logged on or not** and **Run with highest privileges**.
2. **Triggers:** Add **At startup** with a 30-second delay.
3. **Actions:** Add **Start a program**.
   - Program/script: `C:\Program Files\nodejs\node.exe`
   - Add arguments: `server.js`
   - Start in: `C:\dev\multimedica-local-print-server`
4. **Conditions:** Clear restrictions that would prevent startup on battery power if this is appropriate for the clinic computer.
5. **Settings:** Allow the task to run on demand and restart it after failure.

Restart Windows. Without manually starting the server, verify from another clinic computer:

```text
http://<print-server-ip>:3333/health
```

Then print one final test ticket.

---

## 12. Updating the application

On the Windows print-server computer:

```powershell
Set-Location C:\dev\multimedica-local-print-server
git status --short
git pull --ff-only origin main
npm install
```

If `git status --short` lists files, stop rather than overwriting local work. After updating, restart the scheduled task or restart Windows, then repeat the health and test-ticket checks.

Do not replace only `server.js`; update the repository and dependencies together.

---

## 13. Troubleshooting quick reference

| Symptom | Most likely checks |
|---|---|
| Printer pings but does not print | Run `Test-NetConnection <printer-ip> -Port 9100`; verify raw printing is enabled |
| `/health` works only on the host | Windows Firewall, Private network profile, client isolation, VLAN rules |
| Browser says `Failed to fetch` | Correct print-server URL; test `/health` from the same browser |
| Browser says connection refused | Server not running, wrong IP/port, scheduled task failed |
| Health says printer host is not configured | `.env` missing, misnamed, or stored outside repository root |
| Server logs printer socket timeout | Printer address/port, printer offline, network path, raw TCP disabled |
| Ticket prints without Spanish accents | Current application limitation; do not change printer settings during installation |
| Ticket layout or logo is wrong | Confirm current repository, `assets/logo-ticket.png`, and printer width configuration |

---

## 14. Installation record

```text
Installation date:
Installer:
Windows computer name:
Print-server IPv4 address:
Print-server port:
Repository revision:
Node.js version:
Printer make/model:
Printer IPv4 address:
Printer port:
Multimedica location:
Remote health check passed:
Automatic startup verified after restart:
Test ticket printed and scanned:
Notes:
```

---

## 15. Completion checklist

- [ ] Windows host and printer have stable addresses
- [ ] Node.js LTS and Git installed
- [ ] Printer TCP port 9100 reachable
- [ ] Repository installed in `C:\dev\multimedica-local-print-server`
- [ ] `npm install` completed
- [ ] `.env` created in repository root
- [ ] Local `/health` check passed
- [ ] Remote `/health` check passed
- [ ] Multimedica location uses the correct two addresses
- [ ] Test ticket printed, cut, and scanned successfully
- [ ] Automatic startup verified after Windows restart
- [ ] Installation record completed
