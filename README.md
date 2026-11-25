# ScareBooth

A local horror photobooth, in English and 中文 together. Guests read how it works, then answer five questions on the big screen; four of them end in a photo. The first three are normal. During the fourth, a jump-scare appears inside the live camera picture while the booth quietly takes a burst of reaction shots. The iPad is only used to start a session. Everything else happens on the main display, and ScareBooth automatically picks the biggest reaction for the 4-photo strip.

Everything runs on one Windows PC. You don't need an account, a cloud service or internet access during the event.

```
 ┌───────────── Windows PC ─────────────┐        same Wi-Fi        ┌──────── iPad ────────┐
 │  ScareBooth server (Node.js)         │ ◄──────────────────────► │  Safari: /controller │
 │   ├─ /display  → booth monitor       │                          │  start · prompts ·   │
 │   │    webcam + scare + captures     │                          │  pick reaction ·     │
 │   ├─ /admin    → operator console    │                          │  download strip      │
 │   └─ data\sessions\…  (all photos)   │                          └──────────────────────┘
 └──────────────────────────────────────┘
```

---

## Themes

ScareBooth has two looks. Switch between them in the console under **Theme**:

- **♥ Romance — "Till Death Do Us Part"** (default): blush pink and rose, flower corners, floating hearts and petals, script lettering, a heart-shaped countdown, and a pink strip with roses. The questions are romantic ("Look lovingly into each other's eyes…") and the final photo is tagged *"Till death…"*. The jump scare is still the twist.
- **Horror**: the original dark crimson haunted look.

Switching theme also swaps the title, questions and strip footer to that theme's wording. Anything you've written yourself is kept. The title (**Booth & strip title**) appears on the big screen, the iPad, the strip and the phone download page.

## 1. One-time setup (about 10 minutes)

**You need:** a Windows 10/11 PC, a USB webcam, a monitor, speakers, an iPad, and one Wi-Fi network for the PC and iPad.

1. **Install Node.js.** Download the **LTS** installer from <https://nodejs.org> and keep the default options. This is the only step that needs internet.
2. **Copy the `ScareBooth` folder** somewhere permanent, for example `C:\ScareBooth`.
3. **Let the iPad reach the PC.** Double-click **`allow-ipad-access.bat`** and click *Yes* when Windows asks for permission. This opens port 8080 in the Windows Firewall.
   If Windows also shows a firewall pop-up the first time the server starts, tick **Private networks** and click *Allow*.
4. **Check webcam privacy.** In Windows, go to *Settings → Privacy & security → Camera*. Turn on both *Camera access* and *Let desktop apps access your camera*.
5. **Close other camera apps.** Close Zoom, Teams, OBS and the Windows Camera app. Only one app can use most webcams at a time.

## 2. Starting the booth

Double-click **`start-scarebooth.bat`**. It does three things:

- It starts the server in a console window. **Keep that window open.** It prints the iPad address.
- It opens the **booth display** full-screen on the main monitor. The camera and sound are approved automatically.
- It opens the **operator console** (`http://localhost:8080/admin`) in your normal browser.

To close the full-screen display, press **Alt + F4**. To stop the server, close its console window or press **Ctrl + C** in it.

### On the iPad

1. Connect the iPad to the **same Wi-Fi** as the PC.
2. In Safari, open the address shown in the server window or in the operator console, for example `http://192.168.1.23:8080/controller`.
3. Tap **Share → Add to Home Screen**. Opening ScareBooth from that icon runs it full-screen, without Safari's toolbars.
4. Set *Settings → Display & Brightness → Auto-Lock* to **Never**.
5. Optional but recommended: turn on **Guided Access** (*Settings → Accessibility → Guided Access*), open ScareBooth, then triple-click the side button. This stops guests leaving the app.

### Two screens on one PC

If the PC has a laptop screen plus the booth monitor, the easiest setup is to make the booth monitor the **main display** (*Windows Settings → System → Display*). The other option is to set the booth monitor's desktop position at the top of `start-scarebooth.bat`:

```bat
set SCAREBOOTH_DISPLAY_POS=1920,0
```

Other options are documented in the comments at the top of that file: the port number, Chrome or Edge, and a normal window instead of kiosk mode.

## 3. Guest experience

1. **iPad → Start.** Everything guests see is shown in **English with the Chinese underneath**: the instructions, every question, the countdown labels, print and download messages, and the phone download page.
2. **Instructions** appear on the iPad and the main display (*How it works*, editable in the console; the scare is never mentioned). Guests press the second **Start** on the iPad (or **Back**). After 90 s with nobody pressing Start, the booth returns to the language screen. The session video starts recording when they press Start.
3. **Five questions on the main display, at the top of the screen:**
   - **Question 1 is a warm-up:** the couple answers it, and **no photo is taken**.
   - **Questions 2–5 each end in a photo** (4 photos in total).
   - **The question pops up at the top**, and **an answer timer** drains while the couple answers out loud (time set per question).
   - **The question disappears** and the heart **countdown** 3-2-1 runs over the camera picture.
4. **Photos 1–3 (questions 2–4):** the **main display blinks black** as the photo is taken. Faces are lit by the room light, or by the flash light if you switch on *Also fire the flash light for photos 1–3* in the Lights card. (To make the screen itself the flash instead, choose *White* under *Timing & photos → Screen flash colour*.) The booth takes a burst of photos **before, during and after** the flash (8 by default) and **keeps the best one**: eyes open, faces well lit (not too dark or blown out), sharp, and everyone in the picture. If the lights box is set up, the flash light can fire too.
5. **Photo 4, the jump scare (question 5):** the question and countdown start as normal, but the **jump-scare video cuts straight in while the countdown shows “2”** (no black screen; set *Scare strikes on countdown number* in the console, or 0 for a random moment). At the same instant **the room light turns off, the LED strip turns red and the flash light comes on**. 6 reaction photos are taken, then the lights go back to normal. **The booth picks the best reaction itself:** the biggest jump, well lit, sharp, faces visible.
6. **The session video stops** once the last photo is taken. It's saved on the PC only.
7. **The strip appears on the main display** and is saved on the PC.
8. **The strip prints automatically:** one 4R sheet, cut into **2 strips** (if printing is on). If you turn on *Ask guests how many prints they want*, the iPad asks instead.
9. **QR codes appear** on the main display and the iPad, so guests can download the strip and photos on their phone.
10. After 25 s, or when someone taps **Start a new session** on the iPad, the booth goes back to the start screen.

*Optional (console → Timing & photos):* show a warning screen before starting, or let guests pick the final photo on the iPad.

### Portrait main display
Turn the monitor to portrait in Windows (*Settings → System → Display → Display orientation: Portrait*). ScareBooth switches layout automatically. The camera picture is hidden until Start is pressed, and the countdown appears on the camera picture (on the last photo the jump scare replaces it).

**Full-screen camera (recommended): mount the webcam on its side.**
1. Fix the webcam to a small tripod or clamp turned 90°, so it films tall like the screen.
2. In the operator console, **Camera → Camera rotation**: choose *Turn 90° clockwise* or *Turn 90° anticlockwise*, whichever makes people stand upright. The preview in the *Scare & overlay* card turns upright straight away.
3. The camera picture now fills the whole portrait screen with nothing cropped. The question sits at the bottom over the picture and the heart countdown in the middle.
4. The saved photos and the session video come out tall. The strip keeps its usual look (4 landscape photos stacked): each tall photo is cropped to that shape around the couple's faces, so heads are never cut off. Printing is unchanged. The full tall photos are still saved in the session folder.
5. Check the scare's size in *Scare & overlay* (*Size*): on a tall picture you may want it smaller, e.g. 0.6–0.75.

**Camera upright (not rotated):** the camera picture runs full width in the middle of the screen with the question above it. Photos and strips are landscape. A landscape monitor gets the full-screen layout.

### Session video
Each session is recorded from Start until the last photo: the camera picture plus sound from the microphone (choose it in the console). It's saved as `interaction.mp4` (or `.webm`) in the session's folder. The video is **never** shared: it isn't on the QR download page and can't be opened from the iPad or the network. Open it from the gallery on the PC.

## 4. Operator console (`/admin`, on the PC only)

| Area | What you can do |
|---|---|
| **Booth status** | See whether the display, camera, iPad, sound and server are connected. Shows the iPad address. You can restart the camera, reload the display, cancel a stuck session or open the gallery. |
| **Scare & overlay** | **Preview as Landscape / Portrait screen** shows the preview shaped like your main display, with the camera picture placed exactly as the booth places it, so you can position the scare for a portrait monitor. Pick or upload a scare. Drag the scare in the preview to move it and scroll to resize it, or use the sliders. Other settings: entrance animation, how long an image stays up, fade-out time, flip, and edge softness. Chroma key has a key colour (with **Auto-detect**), similarity, edge smoothness and spill reduction. **Play scare here** previews the scare in the console. **Test scare on booth** runs the real scare, sound and burst on the monitor and reports the timing. **Show placement on booth screen** shows the scare frozen, with an outline, over the real camera picture. |
| **Camera** | Choose the webcam and resolution. Choose fill or letterbox. Turn mirrored preview and mirrored saved photos on or off. Turn on **Demo camera** to run the whole flow with a simulated camera. |
| **Sound** | Set the master volume. Choose the sting sound (built-in, none, or an uploaded MP3/WAV/OGG/M4A). Choose whether to play the scare video's own audio. **Test sound** plays it on the booth. |
| **QR download** | Turn the QR code on or off, choose the PC address it uses, and enter the booth Wi-Fi details for the *Join Wi-Fi* code. |
| **Printing** | Ask guests how many prints, set the maximum (4), choose what prints if they don't answer (1 copy), choose the paper layout, run a test print, and see the sheets-printed counter. Reprints are done from the gallery. |
| **Questions** | The **five questions in English and 中文** (both are shown, the Chinese under the English). Question 1 is a warm-up with no photo; questions 2–5 each end in a photo. Each has its own **time to answer**, and questions 2–5 their own **countdown**. The scare strikes during question 5's countdown. |
| **Instructions** | The *How it works* steps shown after the language is chosen, in English and 中文, one step per line. |
| **Timing & photos** | Screen flash on/off and its length, how many photos are taken around each flash (8), when the scare strikes during the final countdown, the number of jump-scare reaction photos (6), and the optional warning screen and iPad picker.  **Black flash before the scare** (default 200 ms, 0 = off): on the last photo the screen cuts to black for a moment and comes back with the scare already there, so it appears out of nowhere. For “3, 2, black, scare”, set *Scare strikes* earliest and latest to about 2.0 s with a 3 s countdown.|
| **Session video** | Record on/off, sound on/off, which microphone, video quality, and whether to keep every burst photo (not only the best). |
| **Lights** | Connect the ScareBooth Lights box (or the Simulator), live preview of the room light, strip and flash, test buttons (including **⚡ Test jump-scare lights**), colours, brightness, LED count, and timing. |
| **WiZ bulb** | Find WiZ bulbs on the network, connection status, live colour preview, idle / session / jump-scare colours and brightness, test buttons. |
| **Questions on the main display** | Edit the five questions in both languages (and the optional warning text). |
| **Photo strip** | Set the title, footer line and whether the date shows. **Preview strip design** shows a sample. |

Settings save as you change them. They go straight to the display and iPad, and they're stored in `data\settings.json`.

## 5. QR download for guests' phones

Guests scan one QR code and download their strip and single photos on their own phone, **on mobile data or any Wi-Fi**.

**How it works:** when the laptop is online, ScareBooth opens a free, secure **Cloudflare Tunnel** link (an address like `https://word-word-word.trycloudflare.com`). The QR codes point there, and a single QR marked *"Works on mobile data"* appears on the big screen and the iPad.

- **Only the download pages are on the internet.** ScareBooth runs a separate, locked-down server for the link. It serves just the photo pages (each session has its own random, unguessable link) and their styling. The console, display, iPad page, settings and gallery can never be reached from the internet.
- **Photos stay on your laptop.** They're sent only when a guest opens their link. No account or cloud storage is used.
- **Links work while the booth is running and online.** A guest opening the link at home after the event has ended won't see their photos, so the page reminds them to save before leaving. The address also changes each time ScareBooth starts.
- **If the internet drops,** the QR automatically switches back to the booth Wi-Fi method: a *Join Wi-Fi* QR code plus a download QR that works on the booth Wi-Fi. When the internet returns, the online QR comes back on its own.

**One-time setup (needs internet):**
1. Double-click **`install-online-sharing.bat`**. It downloads Cloudflare's free tunnel tool (`cloudflared`) into the `tools` folder. No account is needed.
2. Restart ScareBooth. In the console under **QR download**, the status turns green: **Internet link online**.
3. Also enter the booth **Wi-Fi name and password** there. That's the fallback when the internet is down.

**Getting the laptop online without losing the booth Wi-Fi:** the iPad still talks to the laptop over the booth Wi-Fi, so the laptop needs internet *and* the booth network.
- **Easiest:** use a travel router that shares an internet connection (venue Wi-Fi or a phone hotspot). Everything joins the router and gets internet.
- **Or:** connect the laptop to the booth router by Ethernet cable, and get internet through the laptop's Wi-Fi or a phone plugged in by USB.

**Options in the console:**
- **Download link:** *Internet link when online* (default), or *Booth Wi-Fi only* to never use the internet.
- **↻ Restart internet link:** reconnects right away instead of waiting for the automatic retry.
- **Fixed public address (advanced):** Cloudflare's free quick links are meant for light use and come with no uptime guarantee. If you want a permanent address that never changes, set up a free Cloudflare account and a **named tunnel** to `http://127.0.0.1:8081` on your own domain. Then enter that address here.

**Saving on a phone:** iPhone users tap and hold the strip, then choose *Save to Photos*. Android users tap *Download*.

## 6. Connecting a printer

ScareBooth sends each strip **straight to the printer**. The booth PC prints it directly, with no browser, no print dialog and no "Save as PDF".

1. **Install the printer on Windows** with the manufacturer's driver. Plug it into the PC by **USB**, and check that it prints a Windows test page.
2. **Set the paper in the printer's Windows preferences** (*Settings → Printers & scanners → your printer → Printing preferences*): paper **4×6 in** (or 2×6), **borderless** if available, and **2-inch cut** on dye-sub photobooth printers. ScareBooth also picks a matching 4×6 or 2×6 paper size automatically when the driver offers one.

   **DNP DS-RX1HS (two 2×6 strips from one 4R sheet):** load the **6-inch (4×6 / 6×8) media**. In *Printing preferences → Layout → Advanced*: **Paper Size: PR (4x6)**, **2inch cut: Enable**, **Border: Disable**, then OK and Apply. ScareBooth always picks *PR (4x6)* itself (or *(6x4)*, the other size DNP can cut), but the **2inch cut** switch only exists in the driver, so it must be set there once. The console shows this reminder when a DNP printer is selected.
3. In the console under **Printing**:
   - Tick **Print strips for guests**. By default every session prints **once, automatically** (one 4R sheet = **2 strips** with the DNP), with no question on the iPad. Tick **Ask guests how many prints they want** only if you want guests to choose.
   - Leave **Print method** on **Straight to the printer**.
   - Choose your **Printer** from the list (press ↻ if you just plugged it in). If you leave it on *Windows default printer*, make sure the default isn't "Microsoft Print to PDF". The console warns you if it is.
   - Choose the **layout**:
     - **4R sheet → two 2×6 strips, cut by the printer.** The usual photobooth setup, and the one for the DNP DS-RX1HS: two copies of the strip side by side on one 4R sheet, and the printer's 2-inch cut splits them. Under **Each print gives the guests**, keep **2 strips** so one print = one sheet = two strips (the iPad tells guests *Each print is 2 photo strips*). Choose **1 strip** to count strips singly instead (3 prints = 2 sheets).
     - **4×6 sheet, one strip in the middle.** For ordinary photo printers; trim by hand.
     - **2×6 strip paper.** For printers with native 2×6 paper.
4. Press **Test print**. A test strip with a red frame prints (on the DNP: **two separate strips**; if they come out joined, the 2inch cut isn't enabled). If edges are cut off or there are white borders, adjust paper size, borderless and scaling in the printer's preferences.
5. Choose what happens **if guests don't pick a number** before the strip screen times out: print a default number of copies (1 by default) or nothing. The iPad tells guests this while it waits.
6. **Reprint any past strip** from the gallery (`http://localhost:8080/gallery`, on the PC): pick the number of copies under the strip and press **Print**.
7. The console shows a **sheets printed** counter (guest prints and reprints), so you can keep an eye on paper and ribbon.

Print jobs are queued, so several arriving at once print one after another. ScareBooth knows the job reached Windows, but it can't see paper-out or ribbon errors. Watch the printer, or the Windows print queue, during the event.

*The other print method,* **Through the display browser**, prints from the display page instead. It only works without a dialog when the display was opened by `start-scarebooth.bat` in Chrome or Edge, and it always uses the Windows default printer. Use it only if direct printing doesn't work on your PC.

**Printers that work well:** dedicated dye-sub photobooth printers (DNP DS-RX1HS / DS620, Citizen CX-02, Mitsubishi CP-D70 series) are fast, cut strips automatically, and are what most professional booths use. Home inkjets also work but are slower and need trimming.

## 6b. Lights: room light, LED strip and flash

ScareBooth controls a small **USB lights box** (an ESP32 board, about RM30, plus off-the-shelf lights) that switches the room light, colours the LED strip and fires a bright LED flash panel. Full shopping list, wiring and setup: **`hardware/README.md`**. The board's code is in `hardware/ScareBoothLights/`.

| Moment | Room light | LED strip | Flash light |
|---|---|---|---|
| Waiting for guests | on | slow pink breathing | off |
| Questions & photos 1–3 | on | soft pink | off (main display is the flash; the flash light can be added) |
| **Jump scare** | **off** | **red** | **on** for the reaction photos |
| After the reaction photos | back on | soft pink | off |

All colours, levels and timings are in the console's **Lights** card. Choose **Simulator** to try it all without hardware.

### WiZ bulb (Wi-Fi colour bulb)

ScareBooth also drives **WiZ** colour bulbs directly over the booth router, with no cloud, account or internet. The bulb follows the same moments: idle colour while waiting, session colour during photos, **red the instant the jump scare hits**, then back.

1. Set the bulb up in the **WiZ app** on a phone, connected to the **same router as the booth PC** (2.4 GHz, not a guest network). In the app, check *Settings → Security → Allow local communication* is on (it is by default).
2. In the router, give the bulb a **fixed IP (DHCP reservation)** so its address never changes.
3. In the console's **WiZ bulb** card, tick **Control the WiZ bulb from ScareBooth** and press **Find bulbs**, then **Use** next to your bulb (or type its IP; several bulbs: separate with commas).
4. Press **⚡ Test jump-scare lights**. The bulb should turn red, then back to the session colour.

Pick colours with one tap in the same card: **Candle, Warm white, Light warm (default while waiting), Neutral, Cool white** use the bulb's own white LEDs (no purple tint); **Blush pink, Rose** and **Custom** use the colour LEDs. The jump scare has its own colour (Blood red by default) and its own **Jump-scare brightness** slider.

### Strip design image

The strip uses the finished **rose-stained "Till Death Do Us Part" design** (`public/assets/strip-template.png`). ScareBooth finds its four black windows automatically and fills them with the photos (the jump-scare shot in the last one), centred on faces. The design already has the title, wedding date and roses, so the logo, date and footer options only apply to the other frames (*Strip frame* in the console's **Photo strip** card).

To change the design, replace `strip-template.png` with another 1:3 image (ideally 1200 × 3600 px) that has **four solid-black boxes** where the photos go.

### Strip logo

The strip ends with the **毒爱 · Till Death Do Us Part** logo in a black band across the bottom. The logo already carries the title, so the top of the strip keeps only the date, and the photos are a little wider to make room. Turn it off in the console's **Photo strip** card (*Logo across the bottom*) to go back to the title and footer line. The strip frame is **Dark** by default (black and red, blending into the logo band), whatever the booth theme; choose *Blush pink with roses* under **Strip frame** for the pink look. To use different artwork, replace `public/assets/strip-logo.png` with your own image on a black background.

## 7. Scare files

ScareBooth always draws the scare on a transparent layer exactly on top of the live camera picture. The webcam keeps playing underneath, so the scare seems to step into the room. You never see a video player, borders or controls, and nothing flashes while the scare loads, because it's loaded in advance.

| Format | Transparency | Notes |
|---|---|---|
| PNG / WebP / SVG image | ✅ alpha channel | Best for a still scare. Use the *Lunge* or *Rise* entrance to give it motion. |
| **WebM (VP9 with alpha)** | ✅ real transparent video | The best choice for a moving scare in Chrome and Edge. |
| MP4 / WebM with a green or blue background | ✅ via **chroma key** | Turn on chroma key and click **Auto-detect**. Then adjust *Similarity* until the background disappears and *Edge smoothness* until the edges look soft. |
| Ordinary MP4 | ❌ none | It shows as a rectangle. Use *Edge softness* to blend its edges, or key out its background. |
| Animated GIF | ⚠️ first frame only | Convert it to WebM instead. |

The default scare is the built-in **transparent jump-scare video**. ScareBooth includes three original scares to test with: a transparent SVG, a **green-screen MP4** for testing chroma key, and a **transparent WebM**.

**Making a transparent WebM from a PNG sequence with alpha** using [ffmpeg](https://ffmpeg.org):

```
ffmpeg -framerate 30 -i frame_%03d.png -c:v libvpx-vp9 -pix_fmt yuva420p -b:v 0 -crf 30 -auto-alt-ref 0 scare.webm
```

**Sound:** the built-in sting is a synthesized shriek, a dissonant stab and a low boom. It plays the instant the scare becomes visible. If your video already has its own scream, set **Sting** to *None* so you don't hear two sounds.

**Clean photos:** captures read directly from the webcam stream. The scare layer, countdowns, flash, grain and all other screen effects are never in the saved images.

## 8. Where photos are stored

```
ScareBooth\data\
  sessions\2026-10-31_21-04-12_ab3f\
    photo1.jpg photo2.jpg photo3.jpg        the best photo from each flash burst
    candidates\photo1_01.jpg …              every photo from each flash burst
    interaction.mp4                         session video (PC only, never shared)
    reaction_01.jpg … reaction_06.jpg       every jump-scare reaction photo
    strip.jpg                               1200×3600 strip (2×6 in at 600 dpi)
    thumbs\…                                small previews for the iPad
    session.json                            timings, questions, which photos were picked and why
  scares\     uploaded scare files
  sounds\     uploaded sting sounds
  tests\      bursts captured by "Test scare"
  settings.json, scarebooth.log
```

Back up or empty the `data` folder between events. You can browse and download every strip at **http://localhost:8080/gallery** on the PC.

## 9. Reliability

- **The PC is in charge of every session.** Once started, a session finishes even if the iPad sleeps or drops off Wi-Fi.
- **Failed photos retry automatically,** up to 2 more times. If the camera still fails, the session ends with a message on the iPad and the photos taken so far are kept.
- **If the display window closes or crashes** during a session, the session ends cleanly and the iPad shows a message. A watchdog catches a display that stops responding.
- **Double taps can't cause problems.** The server only accepts actions that make sense for the current step.
- **Inactive sessions end by themselves** (3 min by default), and the strip screen returns to the start screen after 2 min. Photos taken so far are always kept.
- **Only one display is in charge.** If a second display window opens, the older one stands down and says so.
- **The operator pages only work on the PC.** The console, the display and settings changes are refused from other devices, so guests can't change settings from the iPad. Run the server with `SCAREBOOTH_ALLOW_REMOTE_ADMIN=1` to allow them from other devices.
- **The webcam recovers by itself.** If it's unplugged or busy, the booth shows a clear message and retries.

## 10. Troubleshooting

| Problem | Fix |
|---|---|
| iPad: *"Can't reach the ScareBooth PC"* | Make sure the PC and iPad are on the **same** Wi-Fi network. Run `allow-ipad-access.bat`. Turn off the router's guest mode or client isolation. Use the IP address shown in the console. |
| Display: *webcam busy or blocked* | Close Zoom, Teams, OBS or the Camera app. Check the Windows camera privacy settings from section 1. Then press **Restart camera**. |
| Display: *permission denied* | Use `start-scarebooth.bat`, which grants permission automatically. If you opened the display by hand, click the camera icon in the address bar and choose *Allow*. |
| No scare sound | Console shows *Sound locked*: click the display window once, or start with `start-scarebooth.bat`. Also check the Windows volume and output device. |
| Scare video won't load | Use an H.264 MP4 or a VP9 WebM. The console shows the exact error. |
| Scare video stutters | After every scare (and every **Test scare on booth**), the *Scare & overlay* card shows **how smoothly it played** and the most likely reason if it lagged. Most common: **graphics acceleration is off** in the browser (Chrome/Edge: Settings → System → *Use graphics acceleration when available*, then restart ScareBooth). ScareBooth already keeps the scare light on the graphics card, and records the session video at 720p so the PC stays free for the scare. If your own scare clip stutters: keep it at most **1080p and 30 fps**. Transparent WebM (VP9 with alpha) is decoded by the processor, which is heavy on a slow laptop: a **green-screen H.264 MP4** with *Chroma key* turned on is decoded by the graphics chip instead and plays more smoothly. Plug the laptop into power and set Windows to *Best performance*. |
| Console says *Tunnel tool not installed* | Run `install-online-sharing.bat` once with internet, then restart ScareBooth. |
| Console says *Internet link offline* | The laptop has no internet. Guests still get the Join Wi-Fi + download QR codes. Fix the connection and press **↻ Restart internet link**, or wait for the automatic retry. |
| Phones can't open the QR link | The phone must be on the same Wi-Fi as the PC (use the *Join Wi-Fi* code). Check the QR uses the right PC address in the console, and run `allow-ipad-access.bat`. |
| Nothing prints | In the console, check **Print method** is *Straight to the printer* and the right **Printer** is selected (not a PDF printer). Check the printer prints a Windows test page, then use **Test print**. The console shows the exact error if Windows refuses the job. |
| A print dialog or "Save as PDF" appears | You're on the *Through the display browser* method. Switch to **Straight to the printer**. |
| Full screen needs several F11 presses | Fixed: on the display, **F11** (or **F**, or a double-click) now switches full screen on and off in one press. `start-scarebooth.bat` opens it full screen already. |
| Print is cropped or has borders | Set paper size, borderless and scaling in the printer's *Printing preferences*, then **Test print** again. |
| *Port 8080 is already in use* | ScareBooth is already running in another window. Or set `PORT=8090` at the top of `start-scarebooth.bat`. |
| Display is on the wrong monitor | See *Two screens on one PC* above. |
| Webcam is too dark | ScareBooth uses the camera's own exposure. Light the guests' faces, for example with a warm lamp in front of them. |

## 11. Testing without hardware

1. Run `start-scarebooth.bat`, or `start-server-only.bat` and then open `http://localhost:8080/display`.
2. In the console, turn on **Demo camera**. Two cartoon guests appear, pose for each prompt, and visibly react to the scare.
3. Open `http://localhost:8080/controller` in another browser window as a stand-in for the iPad, and play through a whole session.
4. Use **Test scare on booth** to check scare timing and the burst at any time. Results show in the console log, and the frames are saved in `data\tests`.

## 12. What's been tested and what needs your hardware

**Automated tests passed** (headless Chrome, Chrome's fake webcam and the demo camera):

- **This revision:** iPad Start → questions with answer timers → portrait layout → screen flash with an 8-photo burst around it, and best-shot picking that avoided both the blown-out flash frame and the dark pre-flash frames → jump scare with the lights (simulator): room off, strip red, flash on, then back to normal → automatic best reaction → strip → session video saved (41 s with sound). The best-shot picker found faces and open eyes on real photos and chose the normal photo over overexposed, dark and blurred versions. The lights box code was compiled and its commands tested on this machine; the real ESP32 board couldn't be used here.
- The earlier automatic flow: iPad Start → question + countdown + photo ×3 on the main display → final countdown interrupted by the jump-scare video (it struck on the "2" in testing) → 15-frame burst → automatic reaction pick → strip → print question → printing → QR codes → reset. The optional iPad picker was also tested.
- Internet links: the console, display, settings, gallery and API all return "not found" through the public link, and only the download pages work. With the link online, the big screen and iPad show a single "Works on mobile data" QR, and a phone outside the booth network loads and downloads the strip. When the internet was cut, the QR switched back to Join Wi-Fi + local link, and the online QR returned when it came back. The real Cloudflare tool was also run with no internet; it reported "offline" and kept retrying. Actually creating a live Cloudflare link couldn't be done in the test environment, so that still needs a check on your laptop.
- The QR codes decode correctly (download link and Wi-Fi join). The download page opens from another device on the network, and the strip downloads.
- Print jobs are queued and counted (3 prints on the two-up layout = 2 sheets), tested with a simulated printer. With no answer on the iPad, the default number printed automatically before the booth reset. A gallery reprint printed and was recorded against that session. Headless Chrome doesn't have a physical printer, so actual paper output still needs checking on yours.
- All three scare types composited over the live feed: SVG image, green-screen MP4 with chroma key, and alpha WebM.
- The saved reaction photos are clean, with no overlay in them.
- Burst timing: 15 frames over about 2.5 s, starting on the first visible frame of the scare.
- Error handling: the display disconnecting, a second display taking over, double taps rejected, starting without a display, cancel. Older settings files are upgraded automatically.
- Security: operator pages blocked from other devices, path traversal blocked, bad uploads rejected.

**Please check on the real setup before the event:**

- **Your webcam:** that it delivers the resolution you choose, how much delay its preview has, and how it handles exposure in your lighting. Camera delay means the first reaction frames are about 100–200 ms older than the scare. The burst is long enough to cover that.
- **The iPad in Safari:** Add to Home Screen, and that it reconnects after Wi-Fi drops on the venue network.
- **The automatic reaction pick** with real guests. If you'd rather they choose, turn on the iPad picker.
- **Sound** through your speakers at the volume you want, and that kiosk mode really does play sound without a click.
- **Kiosk launch** on the right monitor, and the Windows Firewall prompt.
- **Your printer with direct printing:** that **Test print** comes out the right size, borderless, cut in the right place, and not rotated. The print script (`scripts/print-strip.ps1`) couldn't be run in the test environment, which has no Windows PC, so this is its first real run.
- **Online QR download:** run `install-online-sharing.bat`, check the console shows *Internet link online*, then scan the QR with a phone on **mobile data** (Wi-Fi off) and download a strip. Also try the fallback: unplug the internet and scan with a phone on the booth Wi-Fi.
- **Your own scare files:** chroma-key settings under your lighting, and placement on the real monitor. Use *Show placement on booth screen*.
- **Performance on the PC:** saving the burst takes under a second on typical hardware. It was slower in the software-rendered test environment.
- **The whole event setup:** run 10–20 sessions back to back to confirm stability.

### This revision also needs checking with your hardware
- **Best-shot picking with real guests:** the face models were tested on real photos with open eyes; a real blink wasn't available to test. Check a few sessions' `candidates` folders against the chosen photos.
- **Screen flash with your webcam:** how quickly the webcam adjusts to the screen flash. Adjust *Screen flash length* and *before/after* times if the best photo is still too bright or dark.
- **The lights box:** build it, upload the code, and use **⚡ Test jump-scare lights**. The USB connection script (`scripts/serial-bridge.ps1`) runs for the first time on your PC.
- **Session video and microphone:** pick the microphone in the console and check a saved video plays with sound.
- **Portrait monitor:** rotate it in Windows and check the layout.
- **Sideways webcam:** after mounting it, pick the Camera rotation that makes people upright, and check that the session video plays upright (it is recorded from the turned picture).

## 13. How it's built

- `public/js/best-shot.js` picks the best photo of each burst; for the jump scare it picks the **most scared faces** (surprised/fearful expression, mouth open, eyes wide), using face models bundled in `public/vendor/face-api/model` (works offline).
- `server/wiz.js` talks to WiZ bulbs over the local network (UDP port 38899).
- `server/lights.js` talks to the lights box over USB (via `scripts/serial-bridge.ps1`), with a built-in simulator. `hardware/` holds the box's code and build guide.
- `public/js/best-shot.js` scores each burst (eyes open, exposure, sharpness, faces, reaction) using the bundled offline face models in `public/vendor/face-api/`.
- `server/server.js` is a dependency-free Node.js server. It handles HTTP, uses Server-Sent Events for live updates, runs the session state machine with watchdogs and timeouts, stores files, and checks settings. You don't need `npm install`.
- `public/display.html`, `js/display.js` and `js/scare-renderer.js` run the booth monitor: camera capture, countdown, hidden delay, the WebGL scare overlay (chroma key, spill suppression, edge feathering, entrance animations), Web Audio sound, the burst capture, and strip building (`js/strip.js`).
- `public/controller.html` and `js/controller.js` are the iPad guest controller.
- `public/admin.html` and `js/admin.js` are the operator console, with a live overlay preview.
- `public/js/demo-camera.js` is the simulated camera used for testing.
- The fonts are Eater, Special Elite and Oswald. They're bundled for offline use, and their licences are in `public/fonts/`.
