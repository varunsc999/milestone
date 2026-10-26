# Milestone

A supervised practice-driving log for new drivers and their guardians, with a built-in **attention monitor** that watches for distraction during a drive.

It is a static web app (HTML, CSS and JavaScript with no build step), so it runs straight from GitHub Pages.

## Features

- **Sign-in gate**: a demo sign-in with an account photo, stored on this device only.
- **Driving log**: create a log, then start drives once a guardian enters their passcode.
- **Live drive**: a drive timer, GPS speed, distance, the route on a map, and sharp-braking and lateral events from the phone's motion sensor.
- **Attention monitor**: starts automatically when a drive starts. The front camera and MediaPipe Face Landmarker check for:
  - eyes closed (drowsy)
  - head turned
  - looking down
  - eyes off the road
  - face out of view

  You get on-screen alerts, warning beeps and a live focus score during the drive.
- **Trips**: review each drive, see its route on a map, and mark it *Guardian verify* (passcode required) or *Flag for review*.
- **Progress**: verified hours toward a 50-hour example target, night hours, verified drives and the review queue.
- **Learn**: step-by-step practice guides.

## Privacy

Everything stays in the browser:
- Trips, the guardian passcode and the account photo are kept in `localStorage`.
- Camera frames are processed on the device and are never recorded or uploaded.
- The only network requests are for the libraries and map tiles listed below.

## Run it locally

Camera and location access need a secure context, so serve the folder rather than double-clicking `index.html`:

```bash
npx serve .
```

or

```bash
python -m http.server 8000
```

Then open http://localhost:8000 (or the port `serve` prints).

## Deploy to GitHub Pages

1. Push this folder to a GitHub repository.
2. In the repo, go to **Settings → Pages**, set **Source** to *Deploy from a branch*, and pick `main` and `/ (root)`.
3. Open the `https://<username>.github.io/<repo>/` link on your phone. GitHub Pages uses https, which the camera and GPS need.

## Project structure

```
milestone/
├── index.html       # all screens (login, Drive, Trips, Progress, Learn)
├── css/styles.css   # Milestone theme
├── js/app.js        # app logic: log, drives, GPS, maps, progress
└── js/attention.js  # attention monitor (camera + face landmarks)
```

## Built with

- [MediaPipe Tasks Vision](https://developers.google.com/mediapipe) for face landmarks
- [Leaflet](https://leafletjs.com/) and [OpenStreetMap](https://www.openstreetmap.org/) for maps
- [Ionicons](https://ionic.io/ionicons) for icons

> Milestone is a practice aid. It is not tamper-proof and not an official permit record. Check your local licensing requirements.
