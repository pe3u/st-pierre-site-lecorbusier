// Day time-lapse player: a solar-clock overlay follows the video; the first and last `hold` seconds are still frames (dawn and night held).
// Dragging the slider takes over: the video pauses and stays under the hand until Play is pressed again.
export function mountTimelapse(root, opts = {}) {
  const video = root.querySelector("video"), start = +(video.dataset.start || opts.start || 6.0), end = +(video.dataset.end || opts.end || 18.5), hold = +(video.dataset.hold || 0),
    clock = root.querySelector(".tl-clock"), bar = root.querySelector(".tl-bar"), fill = root.querySelector(".tl-fill"), play = root.querySelector('[data-act="play"]');
  const thumb = document.createElement("div"); thumb.className = "tl-thumb"; bar.appendChild(thumb);
  let user = false;                                                     // true once the viewer has taken over
  const fmt = (h) => { const hh = Math.floor(h), mm = Math.floor((h - hh) * 60); return String(hh).padStart(2, "0") + ":" + String(mm).padStart(2, "0"); };
  const update = () => {
    const d = video.duration || 0, k = d ? video.currentTime / d : 0, core = Math.max(0.001, d - 2 * hold);
    const kt = d ? Math.max(0, Math.min(1, (video.currentTime - hold) / core)) : 0;      // solar time stands still during the held seconds
    clock.textContent = fmt(start + (end - start) * kt); fill.style.width = (k * 100) + "%"; thumb.style.left = (k * 100) + "%";
  };
  video.addEventListener("timeupdate", update); video.addEventListener("loadedmetadata", update); video.addEventListener("seeked", update);
  const sync = () => play.classList.toggle("on", !video.paused);
  video.addEventListener("play", sync); video.addEventListener("pause", sync);
  play.addEventListener("click", () => { if (video.paused) { user = false; video.play().catch(() => {}); } else { user = true; video.pause(); } });
  bar.addEventListener("pointerdown", (e) => {
    user = true; video.pause(); bar.classList.add("drag");
    const seek = (ev) => { const r = bar.getBoundingClientRect(); video.currentTime = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)) * (video.duration || 0); update(); };
    seek(e); const mv = (ev) => seek(ev), up = () => { bar.classList.remove("drag"); window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up);
  });
  // plays by itself only while visible, and only until the viewer takes over
  new IntersectionObserver((e) => { if (e[0].isIntersecting) { if (!user) video.play().catch(() => {}); } else video.pause(); }, { threshold: 0.5 }).observe(video);
  update(); sync();
}
