// Turns the sideways camera upright for the session video, off the main page.
// Each frame keeps the camera's own timestamp, so the video stays smooth and in sync with the sound
// even while the main page is busy (jump scare, face checks, building the strip).
// Frames are dropped until the recorder has started ('go'), so the first frame isn't older than the sound.
let goAt = null;
self.onmessage = async ({ data }) => {
  if (data && data.go) { goAt = data.at; return; }
  const { readable, writable, rot, outW, outH } = data;
  const canvas = new OffscreenCanvas(outW, outH);
  const ctx = canvas.getContext('2d', { alpha: false });
  const side = rot === 90 || rot === 270;
  const transformer = new TransformStream({
    transform(frame, controller) {
      if (goAt === null) { frame.close(); return; }
      try {
        // fit the (rotated) camera frame into the output size
        const fw = frame.displayWidth, fh = frame.displayHeight;
        const k = side ? Math.min(outW / fh, outH / fw) : Math.min(outW / fw, outH / fh);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.translate(outW / 2, outH / 2);
        ctx.rotate((rot * Math.PI) / 180);
        ctx.drawImage(frame, (-fw * k) / 2, (-fh * k) / 2, fw * k, fh * k);
        const out = new VideoFrame(canvas, { timestamp: frame.timestamp, duration: frame.duration || undefined });
        controller.enqueue(out);
      } catch (e) {
        self.postMessage({ error: String(e && e.message || e) });
      } finally {
        frame.close();
      }
    },
  });
  try {
    await readable.pipeThrough(transformer).pipeTo(writable);
  } catch (_) { /* stream closed when the recording stops */ }
};
