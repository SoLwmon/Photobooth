# ScareBooth Lights box

A small box that lets ScareBooth control three things over one USB cable:

| Output | What it is | What ScareBooth does with it |
|---|---|---|
| **Room light** | A 12 V LED light panel or bar that lights the guests | On (dimmable) normally, **off** for the jump scare |
| **LED strip** | WS2812B (5 V) or WS2815 (12 V) addressable RGB strip around the booth | Slow pink "breathing" when idle, soft pink during a session, **red** for the jump scare |
| **Flash light** | A bright 12 V LED panel aimed at the guests | **On** during the jump-scare reaction photos (the screen is showing the scare, so it can't be the flash), and optionally for photos 1–3 |

Everything runs offline. The box is an ESP32 board running the code in `ScareBoothLights/`.

---

## Using an Arduino UNO (or Nano) instead of the ESP32

The UNO works just as well and is simpler to wire: it sends 5 V signals, so **no level shifter chip** is needed.
Use the code in **`hardware/ScareBoothLightsUno/ScareBoothLightsUno.ino`** (not the ESP32 one).

**Wiring**

```
Laptop ──USB (USB-B cable)──► Arduino UNO
                               D6  ──► 330 Ω resistor ──► ceiling neon strip DATA (input end)
                               D9  ──► MOSFET module SIG / PWM  (MOSFET OUT ──► white COB flash strip)
                               GND ──► Wago ground ◄── 12 V supply (−), MOSFET GND, neon strip GND
12 V supply (+) ──► MOSFET VIN+   and   ──► neon strip 12V
1000 µF capacitor across the neon strip's 12V and GND (stripe / − leg to GND)
```

**Upload the code (once)**
1. Install the **Arduino IDE** (arduino.cc/en/software).
2. *Tools → Manage Libraries…*, search **Adafruit NeoPixel**, click Install.
3. Open `hardware/ScareBoothLightsUno/ScareBoothLightsUno.ino`.
4. *Tools → Board → Arduino AVR Boards → **Arduino Uno***, and *Tools → Port →* the UNO's COM port.
5. Click **Upload** (→). Wait for "Done uploading".
6. Optional check: *Tools → Serial Monitor*, set **115200 baud** and **Newline**, type `PING` → it answers
   `PONG SCAREBOOTH-LIGHTS 1 60`. Type `PULSE 1000` → the flash strip lights for 1 second.
   **Close the Serial Monitor afterwards**, or ScareBooth can't connect.

**Notes**
- The UNO restarts for about 2 seconds whenever the laptop opens its port. ScareBooth waits for it.
- The UNO briefly stops listening while it updates the LED strip, so the code only updates the strip when the
  line is quiet, and ScareBooth re-sends any command the box doesn't confirm. Nothing to do on your side.
- Up to **300** strip sections (the UNO's memory limit) — plenty for a booth ceiling.
- The flash output runs at about 31 kHz, so even a dimmed flash never flickers on camera.
- Strip shows green or blue instead of red? Change `NEO_GRB` to `NEO_RGB` (or `NEO_BRG`) near the top of the
  code and upload again.

## Why an LED panel and not a camera flash (speedlight)?

A webcam records continuously, around 30 pictures a second, and has no shutter that a speedlight can sync with. A speedlight fires for about 1/1000 of a second. That usually lands between two webcam pictures, or lights only a band across one. A **bright LED panel switched on for a moment** (0.5–3 seconds) works properly with a webcam. ScareBooth turns it on just before the reaction photos and off after them.

---

## Shopping list (approximate Malaysian prices; check Shopee or Lazada)

| # | Part | Example search term | Approx. |
|---|---|---|---|
| 1 | **ESP32 dev board** (ESP32-WROOM-32, "DevKit V1", 30 or 38 pin, with micro-USB or USB-C) | `ESP32 DevKit V1` | RM28–35 |
| 2 | **USB data cable** for the board (must carry data, not charge-only) | `micro USB data cable` | RM5–10 |
| 3 | **2 × MOSFET switch modules**, 3.3 V-logic, for 12 V loads (one for the room light, one for the flash) | `D4184 MOSFET module` (or `AOD4184 module`) | RM4–8 each |
| 4 | **Room light**: 12 V LED light bar or panel, 10–20 W, warm or neutral white | `12V LED light bar` / `12V LED panel` | RM20–45 |
| 5 | **Flash light**: bright 12 V LED panel, 30–50 W, daylight white (COB panels are brightest) | `12V COB LED panel 50W` | RM30–60 |
| 6 | **12 V power supply** for both lights, 5 A or more (60 W+) | `12V 5A adapter` | RM25–40 |
| 7 | **LED strip**: WS2812B 5 V, 60 LEDs/m (or WS2815 12 V for long runs) | `WS2812B 60 LED 5m` | RM40–80 |
| 8 | **5 V power supply for the strip**: 5 V 4 A for up to ~2 m, 5 V 10 A for a 5 m roll | `5V 10A power supply` | RM25–45 |
| 9 | 330 Ω resistor, 1000 µF 10 V capacitor, DC barrel sockets, wire, a small project box | `resistor 330 ohm`, `1000uF capacitor` | RM10–20 |
| 10 | *Optional:* 74AHCT125 level shifter (makes the strip signal more reliable) | `74AHCT125` | RM3–6 |

**Total:** roughly **RM190–330**, depending on the lights you choose.

> **Mains safety:** this design only switches **low-voltage 12 V lights**, which is safe to wire yourself. If you want ScareBooth to switch a mains (230 V) lamp, use a certified, enclosed relay unit installed by a qualified person. Never wire mains on a breadboard.

---

## Wiring

```
                        ┌───────────────────────── ESP32 dev board ─────────────────────────┐
  PC  ── USB cable ───► │ USB                                                               │
                        │ GPIO 25 ──────────────► MOSFET #1  "SIG/PWM"   (room light)       │
                        │ GPIO 26 ──────────────► MOSFET #2  "SIG/PWM"   (flash light)      │
                        │ GPIO 16 ── 330 Ω ─────► LED strip  "DIN" (data in, arrow side)    │
                        │ GND ───┬──────────────► MOSFET #1 GND, MOSFET #2 GND              │
                        └────────┼──────────────────────────────────────────────────────────┘
                                 └──────────────► LED strip GND   ◄── ALL GROUNDS JOINED ──►  12 V PSU −, 5 V PSU −

  12 V PSU +  ──► MOSFET #1 "VIN+"   MOSFET #1 "OUT+ / OUT−" ──► Room light  + / −
  12 V PSU −  ──► MOSFET #1 "VIN−"
  12 V PSU +  ──► MOSFET #2 "VIN+"   MOSFET #2 "OUT+ / OUT−" ──► Flash light + / −
  12 V PSU −  ──► MOSFET #2 "VIN−"

  5 V PSU +  ──► LED strip +5V   (1000 µF capacitor across + and − at the strip input)
  5 V PSU −  ──► LED strip GND   (and to ESP32 GND, see above)
```

**Rules that prevent most problems:**
- **Join every ground (GND / −) together**: the ESP32, both power supplies, the MOSFET modules and the strip. Without a shared ground, the strip flickers or doesn't light at all.
- **Don't power the strip from the ESP32's 5 V pin.** It can't supply enough current. Use the separate 5 V supply.
- **Data goes into the strip's input end.** That's the end the little arrows point *away from*.
- **For a 5 m strip, feed 5 V and GND at both ends** to avoid colours fading towards the far end. (A WS2815 12 V strip avoids this; power it from the 12 V supply instead.)
- **MOSFET module labels vary.** Most D4184 boards have `VIN+ VIN− OUT+ OUT−` on the power side and `PWM/SIG` + `GND` on the control side.

---

## Uploading the code (once)

1. Install the **Arduino IDE** from <https://www.arduino.cc/en/software>.
2. *File → Preferences → Additional boards manager URLs:* add
   `https://espressif.github.io/arduino-esp32/package_esp32_index.json`
3. *Tools → Board → Boards Manager:* search **esp32** and install **esp32 by Espressif Systems**.
4. *Tools → Manage Libraries:* search **Adafruit NeoPixel** and install it.
5. Open `hardware/ScareBoothLights/ScareBoothLights.ino`.
6. Plug in the board. Choose *Tools → Board → ESP32 Dev Module* and *Tools → Port → the COM port that appeared*.
   If no port appears, install the board's USB driver. It's printed on the chip near the USB socket: **CP210x** (Silicon Labs) or **CH340** (WCH).
7. Click **Upload** (→). If it stops at "Connecting….", hold the **BOOT** button on the board until uploading starts.
8. To check it, open *Tools → Serial Monitor*, set **115200 baud** and **Newline**, and type `PING`. It should answer `PONG SCAREBOOTH-LIGHTS 1 60`. Then try `STRIP 255 0 0`, `ROOM 255` and `PULSE 1000`. **Close the Serial Monitor afterwards**, or ScareBooth can't open the port.

---

## Connecting it to ScareBooth

1. Plug the box into the booth PC by USB.
2. In the console, find **Lights**, tick **Control the lights from ScareBooth** and leave **Lights box** on **Auto-detect**. It turns green: *Connected — ScareBooth Lights v1 (60 LEDs) on COM3*.
3. Set **LEDs on the strip** to your strip's real count (60 per metre × metres).
4. Press **⚡ Test jump-scare lights**. The room light turns off, the strip turns red, the flash light comes on, and then everything returns to normal.
5. Adjust colours, brightness and timing to taste. The three squares in the Lights card show live what each light is doing.

**No hardware yet?** Choose **Simulator** as the Lights box to try everything; the squares show what the real lights would do.

If the PC stops talking to the box for 60 seconds (for example, if ScareBooth is closed), the box returns to a calm look: room light on, strip soft pink.

---

## Commands (for the curious)

One per line, 115200 baud:

| Command | Effect |
|---|---|
| `PING` | → `PONG SCAREBOOTH-LIGHTS 1 <ledCount>` |
| `LEDS <n>` | number of LEDs on the strip (saved on the board) |
| `ROOM <0-255>` | room light brightness |
| `FLASH <0-255>` | flash light steady brightness |
| `PULSE <ms> [0-255]` | flash on for `<ms>` (max 10 s), then off → `DONE PULSE` |
| `STRIP <r> <g> <b> [brightness]` | strip solid colour |
| `BREATHE <r> <g> <b> [period ms] [brightness]` | strip slow breathing colour |
| `OFF` | everything off |

Pins can be changed at the top of the `.ino` file.
