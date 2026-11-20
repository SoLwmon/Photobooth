/*
  ScareBooth Lights — firmware for the ESP32 lights box
  ------------------------------------------------------
  Controls, from the ScareBooth PC over USB:
    - ROOM light   : 12 V LED light panel/bar, dimmed through a MOSFET module   (GPIO 25)
    - FLASH light  : bright 12 V LED panel used as the "flash", via a MOSFET    (GPIO 26)
    - LED STRIP    : WS2812B / WS2815 addressable strip                        (GPIO 16)

  Board:    any ESP32 dev board (ESP32-WROOM-32 "DevKit V1" or similar)
  Library:  Adafruit NeoPixel  (Arduino IDE → Tools → Manage Libraries → "Adafruit NeoPixel")
  Core:     esp32 by Espressif (Boards Manager), version 2.x or 3.x

  Serial protocol (115200 baud, one command per line, replies end with "\n"):
    PING                         → PONG SCAREBOOTH-LIGHTS 1 <ledCount>
    LEDS <n>                     → OK LEDS        (saved; survives power-off)
    ROOM <0-255>                 → OK ROOM
    FLASH <0-255>                → OK FLASH       (steady)
    PULSE <ms> [0-255]           → OK PULSE … DONE PULSE   (flash on for <ms>, max 10 s)
    STRIP <r> <g> <b> [bri]      → OK STRIP
    BREATHE <r> <g> <b> [ms] [bri] → OK BREATHE   (slow breathing colour)
    OFF                          → OK OFF
  Safety: the flash never stays on longer than 10 s from a PULSE, and if the PC stops talking
  for 60 s the box goes back to a calm "room light on, strip dim" look.
*/
#include <Adafruit_NeoPixel.h>
#include <Preferences.h>

// ---------------- pins (change here if you wire differently)
const int PIN_STRIP = 16;
const int PIN_ROOM  = 25;
const int PIN_FLASH = 26;
const int MAX_LEDS  = 600;

const uint32_t PWM_FREQ = 19000;   // above hearing, no flicker on camera
const uint8_t  PWM_BITS = 8;

Adafruit_NeoPixel strip(MAX_LEDS, PIN_STRIP, NEO_GRB + NEO_KHZ800);
Preferences prefs;

uint16_t ledCount = 60;
uint8_t stripR = 0, stripG = 0, stripB = 0, stripBri = 0;
bool breathing = false;
uint32_t breathePeriod = 4000;
uint32_t pulseUntil = 0;
bool pulsing = false;
uint32_t lastCommand = 0;
String rx;

// --- PWM helpers that work on esp32 core 2.x and 3.x
#if defined(ESP_ARDUINO_VERSION_MAJOR) && ESP_ARDUINO_VERSION_MAJOR >= 3
  void pwmBegin(int pin, int ch) { (void)ch; ledcAttach(pin, PWM_FREQ, PWM_BITS); }
  void pwmWrite(int pin, int ch, uint8_t v) { (void)ch; ledcWrite(pin, v); }
#else
  void pwmBegin(int pin, int ch) { ledcSetup(ch, PWM_FREQ, PWM_BITS); ledcAttachPin(pin, ch); }
  void pwmWrite(int pin, int ch, uint8_t v) { (void)pin; ledcWrite(ch, v); }
#endif
const int CH_ROOM = 0, CH_FLASH = 1;

void setRoom(uint8_t v)  { pwmWrite(PIN_ROOM, CH_ROOM, v); }
void setFlash(uint8_t v) { pwmWrite(PIN_FLASH, CH_FLASH, v); }

void showSolid(uint8_t r, uint8_t g, uint8_t b, uint8_t bri) {
  uint32_t c = strip.Color((uint16_t)r * bri / 255, (uint16_t)g * bri / 255, (uint16_t)b * bri / 255);
  for (uint16_t i = 0; i < MAX_LEDS; i++) strip.setPixelColor(i, i < ledCount ? c : 0);
  strip.show();
}

void calmLook() {           // used at power-on and if the PC goes quiet
  breathing = false;
  setRoom(200); setFlash(0); pulsing = false;
  stripR = 255; stripG = 120; stripB = 160; stripBri = 60;
  showSolid(stripR, stripG, stripB, stripBri);
}

int argInt(const String* a, int n, int i, int def) { return i < n ? a[i].toInt() : def; }
uint8_t clamp255(int v) { return v < 0 ? 0 : (v > 255 ? 255 : v); }

void handle(String line) {
  line.trim();
  if (!line.length()) return;
  lastCommand = millis();
  String a[8]; int n = 0;
  int start = 0;
  while (n < 8) {
    int sp = line.indexOf(' ', start);
    String part = sp < 0 ? line.substring(start) : line.substring(start, sp);
    if (part.length()) a[n++] = part;
    if (sp < 0) break;
    start = sp + 1;
  }
  String cmd = a[0]; cmd.toUpperCase();

  if (cmd == "PING") { Serial.printf("PONG SCAREBOOTH-LIGHTS 1 %u\n", ledCount); return; }
  if (cmd == "LEDS") {
    int v = argInt(a, n, 1, ledCount);
    if (v < 1 || v > MAX_LEDS) { Serial.println("ERR LEDS must be 1-600"); return; }
    ledCount = v; prefs.putUShort("leds", ledCount);
    if (!breathing) showSolid(stripR, stripG, stripB, stripBri);
    Serial.println("OK LEDS"); return;
  }
  if (cmd == "ROOM")  { setRoom(clamp255(argInt(a, n, 1, 0))); Serial.println("OK ROOM"); return; }
  if (cmd == "FLASH") { pulsing = false; setFlash(clamp255(argInt(a, n, 1, 0))); Serial.println("OK FLASH"); return; }
  if (cmd == "PULSE") {
    uint32_t ms = constrain(argInt(a, n, 1, 500), 10, 10000);
    setFlash(clamp255(argInt(a, n, 2, 255)));
    pulseUntil = millis() + ms; pulsing = true;
    Serial.println("OK PULSE"); return;
  }
  if (cmd == "STRIP") {
    breathing = false;
    stripR = clamp255(argInt(a, n, 1, 0)); stripG = clamp255(argInt(a, n, 2, 0)); stripB = clamp255(argInt(a, n, 3, 0));
    stripBri = clamp255(argInt(a, n, 4, 255));
    showSolid(stripR, stripG, stripB, stripBri);
    Serial.println("OK STRIP"); return;
  }
  if (cmd == "BREATHE") {
    stripR = clamp255(argInt(a, n, 1, 255)); stripG = clamp255(argInt(a, n, 2, 0)); stripB = clamp255(argInt(a, n, 3, 80));
    breathePeriod = constrain(argInt(a, n, 4, 4000), 500, 20000);
    stripBri = clamp255(argInt(a, n, 5, 180));
    breathing = true;
    Serial.println("OK BREATHE"); return;
  }
  if (cmd == "OFF") {
    breathing = false; pulsing = false;
    setRoom(0); setFlash(0); stripBri = 0; showSolid(0, 0, 0, 0);
    Serial.println("OK OFF"); return;
  }
  Serial.println("ERR unknown command");
}

void setup() {
  Serial.begin(115200);
  prefs.begin("sblights", false);
  ledCount = prefs.getUShort("leds", 60);
  if (ledCount < 1 || ledCount > MAX_LEDS) ledCount = 60;
  pwmBegin(PIN_ROOM, CH_ROOM);
  pwmBegin(PIN_FLASH, CH_FLASH);
  strip.begin();
  strip.clear(); strip.show();
  calmLook();
  lastCommand = millis();
}

uint32_t lastFrame = 0;
void loop() {
  while (Serial.available()) {
    char c = (char)Serial.read();
    if (c == '\n') { handle(rx); rx = ""; }
    else if (c != '\r' && rx.length() < 120) rx += c;
  }
  uint32_t now = millis();
  if (pulsing && (int32_t)(now - pulseUntil) >= 0) { pulsing = false; setFlash(0); Serial.println("DONE PULSE"); }
  if (breathing && now - lastFrame >= 20) {
    lastFrame = now;
    float phase = (float)(now % breathePeriod) / breathePeriod;           // 0..1
    float k = 0.25f + 0.75f * (0.5f - 0.5f * cosf(phase * 2.0f * PI));   // 25%..100%
    showSolid(stripR, stripG, stripB, (uint8_t)(stripBri * k));
  }
  if (now - lastCommand > 60000UL && lastCommand != 0) { calmLook(); lastCommand = 0; }
}
