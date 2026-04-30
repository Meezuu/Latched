#!/usr/bin/env python3
"""
Downloads the latest Tension Board 2 database directly from the Android APK.
No phone sync required.

Usage:
  python3 sync_db.py
  python3 extract_tension_data.py
"""

from boardlib.db.aurora import download_database

OUTPUT = "/Users/austinwray/Desktop/tension.db"

print("Downloading fresh tension.db from APKPure...")
print("(This pulls the official TB2 Android APK and extracts the database — may take a minute)")
download_database("tension", OUTPUT)
print(f"\nSaved → {OUTPUT}")
print("\nNext step:  python3 extract_tension_data.py")
