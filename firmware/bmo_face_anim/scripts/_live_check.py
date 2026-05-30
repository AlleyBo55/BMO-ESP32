"""Passively read BMO serial WITHOUT resetting the board. Safe to delete.

Reads for 45s so the user has time to perform a long-hold touch gesture.
"""
import serial
import sys
import time

ser = serial.Serial()
ser.port = "/dev/cu.usbmodem1401"
ser.baudrate = 115200
ser.timeout = 0.2
ser.dtr = False
ser.rts = False
ser.open()

deadline = time.time() + 45
while time.time() < deadline:
    chunk = ser.read(4096)
    if chunk:
        sys.stdout.buffer.write(chunk)
        sys.stdout.buffer.flush()
ser.close()
