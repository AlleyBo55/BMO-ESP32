"""Reset the C3 via DTR/RTS, then capture serial output for N seconds."""
import sys
import time
import serial

PORT = sys.argv[1] if len(sys.argv) > 1 else "/dev/cu.usbmodem11401"
DURATION = float(sys.argv[2]) if len(sys.argv) > 2 else 12.0

s = serial.Serial(PORT, 115200, timeout=0.05)
# Hard reset sequence used by esptool: pull RTS low (resets via EN), release.
# On native USB-CDC the C3 doesn't actually wire EN/IO9 to DTR/RTS the way
# the USB-bridge boards do, so this may or may not reset; either way we
# capture whatever the chip emits for DURATION seconds.
s.setDTR(False)
s.setRTS(True)
time.sleep(0.1)
s.setRTS(False)
time.sleep(0.05)
s.setDTR(True)

end = time.time() + DURATION
while time.time() < end:
    chunk = s.read(1024)
    if chunk:
        sys.stdout.write(chunk.decode("utf-8", errors="replace"))
        sys.stdout.flush()
s.close()
