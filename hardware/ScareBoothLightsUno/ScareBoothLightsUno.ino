/*
  ScareBooth Lights — firmware for an Arduino UNO (or Nano) lights box
  ---------------------------------------------------------------------
  Same commands as the ESP32 version, so ScareBooth finds and drives it automatically.

  Wiring (Arduino UNO / Nano):
    D9  ──► MOSFET module SIG/PWM (gate) ──► 24 V white COB light ("flash")   (PWM, ~31 kHz: no flicker on camera)
    D7  ──► 2-channel relay IN1 ──► RGB neon RED wire
    D8  ──► 2-channel relay IN2 ──► RGB neon BLUE wire
    D4  ──► 1-channel relay IN/S ──► RGB neon GREEN wire
           (each relay connects its colour wire to GND; the neon's common + goes to 12 V)
    D6  ──► (optional) 330 Ω ──► addressable WS2811/WS2812 strip DATA — not used with the RGB neon
    D10 ──► same signal as D9 (the COB light also works if its MOSFET wire is on D10)
    GND ──► ground of the relay boards and the MOSFET module (and the 12 V / 24 V supply −)
    5V  ──► VCC of the relay boards
    USB ──► laptop (powers the Uno and carries ScareBooth's commands)
  The Uno sends 5 V signals, so no level shifter is needed.

  Library:  Adafruit NeoPixel  (Arduino IDE → Tools → Manage Libraries → "Adafruit NeoPixel")
  Board:    Tools → Board → Arduino AVR Boards → Arduino Uno   (or Arduino Nano)

  Serial protocol (115200 baud, one command per line):
    PING                           → PONG SCAREBOOTH-LIGHTS 1 <ledCount>
    LEDS <n>                       → OK LEDS        (saved; survives power-off)
    ROOM <0-255>                   → OK ROOM
    FLASH <0-255>                  → OK FLASH       (steady)
    PULSE <ms> [0-255]             → OK PULSE … DONE PULSE   (flash on for <ms>, max 10 s)
    STRIP <r> <g> <b> [bri]        → OK STRIP
    BREATHE <r> <g> <b> [ms] [bri] → OK BREATHE     (slow breathing colour)
    NEON <r> <g> <b>               → OK NEON        (RGB neon colours on the relays: 1 = on, 0 = off)
    NEONINV <r> <g> <b>            → OK NEONINV     (1 = that relay switches on with LOW; saved)
    FLASHINV <0|1>                 → OK FLASHINV    (1 = the COB MOSFET module is on with LOW; saved)
    OFF                            → OK OFF
  Safety: the flash never stays on longer than 10 s from a PULSE, and if the PC stops talking
  for 60 s the box goes back to a calm look (flash off, strip dim pink).

  If the strip shows GREEN or BLUE when ScareBooth asks for RED, change NEO_GRB below to NEO_RGB
  (or NEO_BRG), then upload again.
*/
#include <Adafruit_NeoPixel.h>
#include <EEPROM.h>

// ---------------- pins (change here if you wire differently)
const uint8_t PIN_STRIP = 6;
const uint8_t PIN_FLASH = 9;    // 24 V COB light MOSFET gate. Timer1 pin: ~31 kHz PWM, so a dimmed light never flickers on camera
const uint8_t PIN_FLASH2 = 10;  // Timer1 pin: a copy of the COB signal, so the light works on D9 or D10
const uint8_t PIN_NEON_R = 7;   // 2-channel relay IN1
const uint8_t PIN_NEON_B = 8;   // 2-channel relay IN2
const uint8_t PIN_NEON_G = 4;   // 1-channel relay IN / S
const uint16_t EEPROM_INV = 3;  // 1 byte: neon relay polarity bits (r=1, g=2, b=4), then 1 byte: 0x5A marker
const uint16_t MAX_LEDS = 300;  // the UNO has 2 KB of memory: 300 sections is plenty for a booth ceiling
const uint16_t EEPROM_ADDR = 0; // 2 bytes: LED count, then 1 byte: 0xA5 marker

Adafruit_NeoPixel strip(60, PIN_STRIP, NEO_GRB + NEO_KHZ800);

uint16_t ledCount = 60;
uint8_t stripR = 0, stripG = 0, stripB = 0, stripBri = 0;
bool breathing = false;
uint32_t breathePeriod = 4000;
uint32_t pulseUntil = 0;
bool pulsing = false;
uint32_t lastCommand = 0;
uint32_t lastFrame = 0;
uint32_t lastByteAt = 0;          // when the last character arrived from the PC
bool needShow = false;            // the strip has a new colour waiting to be sent out
uint16_t pendingLen = 0;          // a new LED count waiting to be applied (when the line is quiet)

char rx[64];
uint8_t rxLen = 0;

// ---------------------------------------------------------------- RGB neon on relays
// Most relay boards switch ON when their input is LOW ("low-level trigger"). The polarity of each relay
// is saved (NEONINV) so the neon stays OFF from the moment the Uno powers up.
uint8_t neonInv = 0b101;          // default: red + blue (2-channel board) switch on with LOW, green (1-channel) with HIGH
uint8_t neonOn = 0;               // which colours are on (r=1, g=2, b=4)
bool flashInv = false;            // COB MOSFET module that turns ON with a LOW signal (saved as bit 8 of the same byte)
void writeNeonPin(uint8_t pin, bool on, bool inv) { digitalWrite(pin, (on != inv) ? HIGH : LOW); }
void setNeon(uint8_t bits) {
  neonOn = bits & 7;
  writeNeonPin(PIN_NEON_R, neonOn & 1, neonInv & 1);
  writeNeonPin(PIN_NEON_G, neonOn & 2, neonInv & 2);
  writeNeonPin(PIN_NEON_B, neonOn & 4, neonInv & 4);
}
void loadNeonInv() { if (EEPROM.read(EEPROM_INV + 1) == 0x5A) { uint8_t b = EEPROM.read(EEPROM_INV); neonInv = b & 7; flashInv = b & 8; } }
void saveInv() { EEPROM.update(EEPROM_INV, neonInv | (flashInv ? 8 : 0)); EEPROM.update(EEPROM_INV + 1, 0x5A); }

// ---------------------------------------------------------------- outputs
void setFlash(uint8_t v) { uint8_t o = flashInv ? 255 - v : v; analogWrite(PIN_FLASH, o); analogWrite(PIN_FLASH2, o); }   // 0 = off, 255 = fully on
void setRoom(uint8_t v)  { (void)v; }   // no separate room light any more: D10 copies the COB signal

// While strip.show() sends colours to the LEDs, the UNO cannot receive from the PC (interrupts are off),
// so a command arriving at that moment would be lost. So the colour is only *prepared* here, and sent
// out by loop() once the line from the PC has been quiet for a few milliseconds.
void showSolid(uint8_t r, uint8_t g, uint8_t b, uint8_t bri) {
  if (pendingLen) return;         // the new length is applied first; loop() repaints after that
  uint32_t c = strip.Color((uint16_t)r * bri / 255, (uint16_t)g * bri / 255, (uint16_t)b * bri / 255);
  strip.fill(c, 0, ledCount);
  needShow = true;
}
bool lineQuiet() { return !Serial.available() && millis() - lastByteAt >= 4; }

void calmLook() {                 // at power-on, and if the PC goes quiet
  breathing = false; pulsing = false;
  setFlash(0); setRoom(200); setNeon(0);
  stripR = 255; stripG = 120; stripB = 160; stripBri = 60;
  showSolid(stripR, stripG, stripB, stripBri);
}

void loadLedCount() {
  uint16_t v; EEPROM.get(EEPROM_ADDR, v);
  if (EEPROM.read(EEPROM_ADDR + 2) == 0xA5 && v >= 1 && v <= MAX_LEDS) ledCount = v;
}
void saveLedCount() { EEPROM.put(EEPROM_ADDR, ledCount); EEPROM.update(EEPROM_ADDR + 2, 0xA5); }

void applyLedCount(uint16_t n) {
  strip.clear(); strip.show();    // blank the old length first
  ledCount = n;
  strip.updateLength(ledCount);   // only reserve memory for the LEDs we really have
  strip.begin();
}

// ---------------------------------------------------------------- commands
uint8_t clamp255(long v) { return v < 0 ? 0 : (v > 255 ? 255 : (uint8_t)v); }

void handle(char* line) {
  // split into at most 7 words
  char* a[7]; uint8_t n = 0;
  for (char* tok = strtok(line, " \t"); tok && n < 7; tok = strtok(NULL, " \t")) a[n++] = tok;
  if (!n) return;
  lastCommand = millis();
  for (char* p = a[0]; *p; p++) *p = toupper(*p);
  #define ARG(i, def) ((i) < n ? atol(a[i]) : (long)(def))

  if (!strcmp(a[0], "PING")) { Serial.print(F("PONG SCAREBOOTH-LIGHTS 1 ")); Serial.println(ledCount); return; }
  if (!strcmp(a[0], "LEDS")) {
    long v = ARG(1, ledCount);
    if (v < 1 || v > MAX_LEDS) { Serial.println(F("ERR LEDS must be 1-300")); return; }
    pendingLen = (uint16_t)v;   // applied in loop() once the line is quiet (it needs strip.show())
    ledCount = pendingLen; saveLedCount();
    Serial.println(F("OK LEDS")); return;
  }
  if (!strcmp(a[0], "ROOM"))  { setRoom(clamp255(ARG(1, 0))); Serial.println(F("OK ROOM")); return; }
  if (!strcmp(a[0], "FLASH")) { pulsing = false; setFlash(clamp255(ARG(1, 0))); Serial.println(F("OK FLASH")); return; }
  if (!strcmp(a[0], "PULSE")) {
    long ms = constrain(ARG(1, 500), 10, 10000);
    setFlash(clamp255(ARG(2, 255)));
    pulseUntil = millis() + (uint32_t)ms; pulsing = true;
    Serial.println(F("OK PULSE")); return;
  }
  if (!strcmp(a[0], "STRIP")) {
    breathing = false;
    stripR = clamp255(ARG(1, 0)); stripG = clamp255(ARG(2, 0)); stripB = clamp255(ARG(3, 0));
    stripBri = clamp255(ARG(4, 255));
    showSolid(stripR, stripG, stripB, stripBri);
    Serial.println(F("OK STRIP")); return;
  }
  if (!strcmp(a[0], "BREATHE")) {
    stripR = clamp255(ARG(1, 255)); stripG = clamp255(ARG(2, 0)); stripB = clamp255(ARG(3, 80));
    breathePeriod = constrain(ARG(4, 4000), 500, 20000);
    stripBri = clamp255(ARG(5, 180));
    breathing = true;
    Serial.println(F("OK BREATHE")); return;
  }
  if (!strcmp(a[0], "NEON")) {
    setNeon((ARG(1, 0) ? 1 : 0) | (ARG(2, 0) ? 2 : 0) | (ARG(3, 0) ? 4 : 0));
    Serial.println(F("OK NEON")); return;
  }
  if (!strcmp(a[0], "NEONINV")) {
    neonInv = (ARG(1, 1) ? 1 : 0) | (ARG(2, 1) ? 2 : 0) | (ARG(3, 1) ? 4 : 0);
    saveInv();
    setNeon(neonOn);
    Serial.println(F("OK NEONINV")); return;
  }
  if (!strcmp(a[0], "FLASHINV")) {
    flashInv = ARG(1, 0) != 0; saveInv(); setFlash(0);
    Serial.println(F("OK FLASHINV")); return;
  }
  if (!strcmp(a[0], "OFF")) {
    breathing = false; pulsing = false;
    setFlash(0); setRoom(0); setNeon(0); stripBri = 0; showSolid(0, 0, 0, 0);
    Serial.println(F("OK OFF")); return;
  }
  Serial.println(F("ERR unknown command"));
}

// ---------------------------------------------------------------- setup / loop
void setup() {
  loadNeonInv();
  pinMode(PIN_FLASH, OUTPUT); digitalWrite(PIN_FLASH, flashInv ? HIGH : LOW);   // COB OFF from the very first moment
  pinMode(PIN_FLASH2, OUTPUT); digitalWrite(PIN_FLASH2, flashInv ? HIGH : LOW);
  // neon relays: set the "off" level first, then make them outputs, so no relay clicks on at power-up
  loadNeonInv();
  setNeon(0);
  pinMode(PIN_NEON_R, OUTPUT); pinMode(PIN_NEON_G, OUTPUT); pinMode(PIN_NEON_B, OUTPUT);
  setNeon(0);
  // Timer1 (pins 9 and 10): prescaler 1 → ~31 kHz PWM, far above what a camera or eye can see.
  TCCR1B = (TCCR1B & 0b11111000) | 0x01;

  Serial.begin(115200);
  loadLedCount();
  applyLedCount(ledCount);
  calmLook();
  strip.show(); needShow = false;
  lastCommand = millis();
}

void loop() {
  while (Serial.available()) {
    char c = (char)Serial.read();
    lastByteAt = millis();
    if (c == '\n') { rx[rxLen] = 0; handle(rx); rxLen = 0; }
    else if (c != '\r' && rxLen < sizeof(rx) - 1) rx[rxLen++] = c;
  }
  uint32_t now = millis();
  if (pulsing && (int32_t)(now - pulseUntil) >= 0) { pulsing = false; setFlash(0); Serial.println(F("DONE PULSE")); }
  if (breathing && now - lastFrame >= 40) {
    lastFrame = now;
    float phase = (float)(now % breathePeriod) / breathePeriod;            // 0..1
    float k = 0.25f + 0.75f * (0.5f - 0.5f * cos(phase * 2.0f * PI));     // 25%..100%
    showSolid(stripR, stripG, stripB, (uint8_t)(stripBri * k));
  }
  if (pendingLen && lineQuiet()) {
    uint16_t n = pendingLen; pendingLen = 0;
    applyLedCount(n);           // blanks the old length, then switches to the new one
    if (!breathing) showSolid(stripR, stripG, stripB, stripBri);
  }
  if (needShow && lineQuiet()) { needShow = false; strip.show(); }
  if (lastCommand != 0 && now - lastCommand > 60000UL) { calmLook(); lastCommand = 0; }
}
