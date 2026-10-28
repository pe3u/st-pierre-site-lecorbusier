import { mountPano } from "./pano.js";
import { mountTimelapse } from "./timelapse.js";

// ---- notes for the 3D viewer: positions are Blender metres (real east = +Y); `face` is an outward direction used to hide notes turned away from the camera
const NOTES = [
  { side: "ext", title: "Square to cone", pos: [12.5, 11, 33.6], text: "A square plan of about 25 m rises into a truncated cone some 33 m high. Le Corbusier traced the idea to his unbuilt Le Tremblay church of 1929 and to the hyperbolic forms of Chandigarh." },
  { side: "ext", title: "Light cannons", pos: [12.1, 9.6, 33.4], text: "Instead of windows, tilted tubes pierce the roof. Tinted yellow and red, they catch the sun at set hours and throw coloured light across the concrete." },
  { side: "ext", title: "Orion, in concrete", pos: [12, 20.5, 18], face: [0, 1, 0.3], text: "On the east wall, small openings draw the constellation Orion. In the morning the sun passes through them and scatters points of light across the nave." },
  { side: "ext", title: "Bare concrete", pos: [24.6, 11, 9], face: [1, 0, 0], text: "Walls, floors, altar and pulpit are left as raw concrete. In this model the formwork joints are drawn as a 1.2 × 2.4 m grid, with chamfered 2 cm edges." },
  { side: "ext", title: "Four levels, linked by ramps", pos: [12.5, -4.2, 3.2], face: [0, -1, 0], text: "Sacristy, presbytery and catechism rooms sit below; the prayer space is above. Ramps tie the four levels to the hillside of the former quarry." },
  { side: "ext", title: "Polychromy", pos: [11.8, -4.0, 5.6], face: [0, -1, 0], text: "Flat colour (blue, red, yellow, green) is kept for doors and small volumes, so the grey mass reads even stronger." },
  { side: "int", title: "A raked nave", pos: [19, 6, 9.8], text: "Seating rises in steps along the walls: an unusual arrangement for a Catholic church, which places the congregation around the altar rather than in front of it." },
  { side: "int", title: "One material", pos: [10, 12.5, 7.2], text: "Altar, platform and pulpit are cast in the same bare concrete as the walls: one material, one language." },
  { side: "int", title: "A beam on the wall", pos: [1.6, 9.6, 15.5], text: "Around solar noon in late summer the sun runs down the yellow cannon and lands as an ellipse on the wall. The patch drifts as the day moves." },
  { side: "int", title: "Orion from within", pos: [11, 20.4, 17], text: "Seen from inside, the constellation becomes a field of white points against dark concrete: daylight reduced to dots." },
  { side: "int", title: "Slots of colour", pos: [1.8, 14, 8.6], text: "Bands of coloured light follow the ledges around the room. In this visualisation they are an interpretive lighting study." },
  { side: "int", title: "A lantern and a clock", pos: [12.1, 9.6, 29.2], text: "The cannon tints the light and its angle decides the hour: it is a lantern and a clock at once." },
];

// ---- 3D viewer (loaded lazily when it nears the viewport; the heavy model never blocks the page)
const v3 = document.querySelector("#v3");
const loadBar = v3.querySelector(".v3-load i"), loadTxt = v3.querySelector(".v3-load span"), loadBox = v3.querySelector(".v3-load");
let viewerStarted = false;
async function startViewer() {
  if (viewerStarted) return; viewerStarted = true;
  try {
    const { createViewer } = await import("./viewer3d.js");
    await createViewer(v3, {
      modelUrl: "assets/model/church_web.glb", contextUrl: "assets/model/context.glb", treesUrl: "assets/model/trees.json", hotspots: NOTES,
      onProgress: (k) => { loadBar.style.width = (k * 100).toFixed(0) + "%"; loadTxt.textContent = "Loading the model · " + (k * 100).toFixed(0) + "%"; },
    });
    loadBox.classList.add("done");
  } catch (e) {
    console.error(e);
    loadTxt.textContent = /WebGL|context/i.test(String(e)) ? "The 3D viewer needs WebGL." : "The 3D model could not be loaded. Open the site with “Open site.bat”.";
    loadBox.classList.add("failed");
  }
}
new IntersectionObserver((e) => { if (e[0].isIntersecting) startViewer(); }, { rootMargin: "600px" }).observe(v3);
startViewer();   // the hero: start straight away

// ---- other components
mountPano(document.querySelector("#pano"), { base: "assets/pano/", views: [{ file: "pano_1.jpg", name: "Upper seating" }, { file: "pano_2.jpg", name: "Altar platform" }, { file: "pano_3.jpg", name: "Lower seating" }] });
document.querySelectorAll(".tl").forEach((el) => mountTimelapse(el));

// ---- reveal on scroll
const io = new IntersectionObserver((entries) => entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } }), { threshold: 0.12 });
document.querySelectorAll(".reveal").forEach((el) => io.observe(el));

// ---- active section in the header
const links = [...document.querySelectorAll(".nav a")];
const secs = links.map((a) => document.querySelector(a.getAttribute("href"))).filter(Boolean);
const so = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) links.forEach((a) => a.classList.toggle("on", a.getAttribute("href") === "#" + e.target.id)); }), { rootMargin: "-45% 0px -50% 0px" });
secs.forEach((s) => so.observe(s));

// ---- lightbox for the still images
const lb = document.querySelector("#lightbox"), lbImg = lb.querySelector("img"), lbCap = lb.querySelector("figcaption");
document.querySelectorAll("[data-full]").forEach((fig) => {
  fig.addEventListener("click", () => { lbImg.src = fig.dataset.full; lbCap.textContent = fig.querySelector("figcaption")?.textContent || ""; lb.classList.add("show"); document.body.classList.add("noscroll"); });
});
const closeLb = () => { lb.classList.remove("show"); document.body.classList.remove("noscroll"); setTimeout(() => (lbImg.src = ""), 250); };
lb.addEventListener("click", closeLb); window.addEventListener("keydown", (e) => { if (e.key === "Escape") closeLb(); });
