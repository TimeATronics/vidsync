# Mobile-First Watch Party System: A High-Level Blueprint

This document outlines a streamlined, cost-effective system designed specifically for two people to watch streams in perfect sync while on a video/audio call, optimized entirely for Android phones. The system should work with web browsers in general, so one person on a desktop PC web browser and one on an Android phone browser should work as well as both on phone browsers or both on Desktop browsers as well

## 1. The Foundation (Leveraging the GitHub Student Pack)
Since you have the GitHub Student Developer Pack, you can host this entire system for free for at least a year.

* **The Brains (Cloud Server):** Use your **DigitalOcean** credits (or Azure) to set up a basic cloud server. This server will act as the middleman—fetching the video streams securely and keeping your phones in sync.
* **The Web Address:** Use **Namecheap** or **TechDomains** (included in the pack) to get a free domain name (e.g., `ourmovienight.me`).
* **Security (SSL):** Modern phones will block camera and microphone access unless the site is highly secure. You will use a free security certificate (Let's Encrypt) to ensure the site runs on standard HTTPS.

## 2. The Core Features

### A. The Stream Extractor
Instead of dealing with popup ads or complicated video players from third-party sites, your server does the heavy lifting. You paste a link into your app, and your server quietly visits the site, extracts the raw video feed, and repackages it. This bypasses the protections that usually stop custom video players from working.

### B. The Sync Engine
This is the invisible "conductor." It is a lightweight connection running on your cloud server. 
* If one person pauses to take a break, the other person's phone pauses instantly.
* If someone skips an intro, it skips for both.
* It constantly checks the timestamps to ensure neither phone falls behind due to brief internet drops.

### C. The Communication Hub
For the actual video and audio call, we bypass building a complex custom network and integrate a free, open-source tool like **Jitsi Meet**. This acts as a separate, secure layer running right alongside the video player.

## 3. The Android Experience: Solving Audio & Mobile Quirks
Running a video stream and an active video call simultaneously on an Android browser is the most challenging part of this project due to how phones manage audio routing. Here is how the system handles it:

### The "Double Audio" Problem (Echo & Feedback)
When an Android phone opens the microphone for a call, the operating system often lowers the volume of other media (like your movie) or causes the microphone to pick up the movie sound, creating a terrible echo.
* **Software Fix:** The communication hub (Jitsi) must be configured to aggressively enforce **Echo Cancellation** and **Noise Suppression**. This tells the phone's hardware to filter out the sound of the movie before sending your voice across the internet.
* **Hardware Reality:** For the absolute best mobile experience without audio ducking (where the movie gets quiet when someone speaks), **using Bluetooth earbuds or wired headphones is highly recommended.** This physically isolates the movie audio from the microphone.

### Keeping the App Alive (Background Play)
Mobile browsers aggressively put tabs to sleep if you switch to another app (like checking a message). 
* **The Solution:** The system should be built as a **Progressive Web App (PWA)**. This means when you open the website on your Android phone, you can click "Add to Home Screen." It will then look and act exactly like a native app. It gets its own icon, hides the browser address bar, and most importantly, it tells the Android operating system to keep the video and call running even if you briefly minimize the screen.

## 4. The User Flow
1.  Both of you tap the app icon on your Android home screens.
2.  You enter a private, shared room. The video cameras connect instantly.
3.  One person pastes a link to a movie or show. 
4.  The server extracts the clean video feed and beams it to both screens.
5.  You hit play, and the movie starts simultaneously, with your voice/video call running seamlessly in the corner of the screen.