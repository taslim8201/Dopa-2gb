const $ = s => document.querySelector(s);

let videoUrl = "";
let thumbUrl = "";
let r2VideoUrl = "";
let r2Busy = false;

const savedCloud = localStorage.getItem("cloudName") || "";
const savedPreset = localStorage.getItem("uploadPreset") || "";

$("#cloudName").value = savedCloud;
$("#uploadPreset").value = savedPreset;

function saveConfig() {
  localStorage.setItem("cloudName", $("#cloudName").value.trim());
  localStorage.setItem("uploadPreset", $("#uploadPreset").value.trim());
}

function toggleSource() {
  const source = $("#videoSource").value;
  $("#r2Box").style.display = source === "r2" ? "block" : "none";
  $("#cloudinaryBox").style.display = source === "cloudinary" ? "block" : "none";
  $("#youtubeBox").style.display = source === "youtube" ? "block" : "none";
}
$("#videoSource").onchange = toggleSource;
toggleSource();

function getYouTubeId(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes("youtu.be")) return u.pathname.replace("/", "").split("/")[0];
    if (u.hostname.includes("youtube.com")) {
      if (u.pathname === "/watch") return u.searchParams.get("v");
      if (u.pathname.startsWith("/shorts/")) return u.pathname.split("/")[2];
      if (u.pathname.startsWith("/embed/")) return u.pathname.split("/")[2];
    }
  } catch {}
  return null;
}

function widget(resourceType, done) {
  saveConfig();
  const cloudName = $("#cloudName").value.trim();
  const uploadPreset = $("#uploadPreset").value.trim();
  if (!cloudName || !uploadPreset) return alert("Cloudinary Cloud Name and Unsigned Upload Preset are required.");

  cloudinary.createUploadWidget({
    cloudName, uploadPreset, sources: ["local"], multiple: false, resourceType,
    clientAllowedFormats: resourceType === "video" ? ["mp4", "webm", "mov", "m4v"] : ["jpg", "jpeg", "png", "webp"],
    maxVideoFileSize: 2147483648, maxChunkSize: 20000000, folder: "dopa",
    showAdvancedOptions: false, cropping: false, theme: "green"
  }, (error, result) => {
    if (error) { console.error(error); $("#status").textContent = error.message || "Upload failed."; return; }
    if (result.event === "upload-added") $("#status").textContent = "Uploading…";
    if (result.event === "success") { done(result.info.secure_url); $("#status").textContent = "Upload complete."; }
  }).open();
}

$("#videoBtn").onclick = () => widget("video", url => { videoUrl = url; $("#videoStatus").textContent = "✓ Uploaded"; });
$("#thumbBtn").onclick = () => widget("image", url => { thumbUrl = url; $("#thumbStatus").textContent = "✓ Uploaded"; });

async function uploadToR2(file) {
  if (!file) return;
  if (!file.type.startsWith("video/")) return alert("Please choose a video file.");
  const password = $("#password").value.trim();
  if (!password) return alert("Enter admin password first.");

  r2Busy = true;
  $("#r2VideoStatus").textContent = `Preparing ${formatBytes(file.size)} upload…`;
  $("#status").textContent = "Preparing large upload…";

  let session;
  try {
    let r = await fetch("/.netlify/functions/r2-upload", {
      method: "POST", headers: { "content-type": "application/json", "x-admin-password": password },
      body: JSON.stringify({ action: "create", fileName: file.name, contentType: file.type || "video/mp4", fileSize: file.size })
    });
    session = await r.json();
    if (!r.ok) throw new Error(session.error || "Could not start R2 upload.");

    const parts = new Array(session.partCount);
    const concurrency = 3;
    let next = 1, completed = 0;
    async function worker() {
      while (true) {
        const partNumber = next++;
        if (partNumber > session.partCount) return;
        const start = (partNumber - 1) * session.partSize;
        const end = Math.min(start + session.partSize, file.size);
        const blob = file.slice(start, end);
        let lastError;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            const response = await fetch(session.urls[partNumber - 1], { method: "PUT", body: blob, headers: { "Content-Type": file.type || "application/octet-stream" } });
            if (!response.ok) throw new Error(`Part ${partNumber} failed (${response.status})`);
            const etag = response.headers.get("ETag") || response.headers.get("etag");
            if (!etag) throw new Error("R2 did not return an ETag. Check bucket CORS ExposeHeaders: ETag.");
            parts[partNumber - 1] = { PartNumber: partNumber, ETag: etag };
            completed++;
            const pct = Math.round((completed / session.partCount) * 100);
            $("#r2VideoStatus").textContent = `Uploading… ${pct}% (${completed}/${session.partCount} parts)`;
            $("#status").textContent = `Large upload: ${pct}%`;
            lastError = null;
            break;
          } catch (e) { lastError = e; await new Promise(resolve => setTimeout(resolve, 1000 * attempt)); }
        }
        if (lastError) throw lastError;
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, session.partCount) }, worker));

    r = await fetch("/.netlify/functions/r2-upload", {
      method: "POST", headers: { "content-type": "application/json", "x-admin-password": password },
      body: JSON.stringify({ action: "complete", key: session.key, uploadId: session.uploadId, parts })
    });
    const done = await r.json();
    if (!r.ok) throw new Error(done.error || "Could not complete R2 upload.");
    r2VideoUrl = done.url;
    $("#r2VideoStatus").textContent = "✓ Large video uploaded";
    $("#status").textContent = "Large upload complete. Now publish the episode.";
  } catch (error) {
    console.error(error);
    $("#r2VideoStatus").textContent = "Upload failed";
    $("#status").textContent = error.message || "Large upload failed.";
    if (session?.key && session?.uploadId) {
      fetch("/.netlify/functions/r2-upload", { method: "POST", headers: { "content-type": "application/json", "x-admin-password": password }, body: JSON.stringify({ action: "abort", key: session.key, uploadId: session.uploadId }) }).catch(() => {});
    }
  } finally { r2Busy = false; }
}

function formatBytes(bytes) {
  const units = ["B", "MB", "GB", "TB"];
  let n = bytes, i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 2 : 0)} ${units[i]}`;
}

$("#r2VideoBtn").onclick = () => {
  if (r2Busy) return;
  const input = document.createElement("input");
  input.type = "file"; input.accept = "video/*";
  input.onchange = () => uploadToR2(input.files[0]);
  input.click();
};

$("#publishBtn").onclick = async () => {
  saveConfig();
  const password = $("#password").value.trim();
  if (!password) return alert("Enter admin password.");
  if (r2Busy) return alert("Wait for the large video upload to finish.");
  const source = $("#videoSource").value;
  let finalVideoUrl = "", finalThumbUrl = "", videoType = source;

  if (source === "r2") {
    if (!r2VideoUrl) return alert("Upload the large video first.");
    finalVideoUrl = r2VideoUrl;
    finalThumbUrl = thumbUrl;
  } else if (source === "cloudinary") {
    if (!videoUrl) return alert("Upload the video first.");
    finalVideoUrl = videoUrl; finalThumbUrl = thumbUrl;
  } else {
    const youtubeUrl = $("#youtubeUrl").value.trim();
    if (!youtubeUrl) return alert("Enter YouTube video URL.");
    const videoId = getYouTubeId(youtubeUrl);
    if (!videoId) return alert("Invalid YouTube video URL.");
    finalVideoUrl = `https://www.youtube.com/embed/${videoId}`;
    finalThumbUrl = `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
  }

  const payload = {
    title: $("#titleInput").value.trim() || "Untitled Episode",
    season: Number($("#seasonInput").value) || 1,
    episode: Number($("#episodeInput").value) || 1,
    duration: $("#durationInput").value.trim(),
    description: $("#descriptionInput").value.trim(),
    videoUrl: finalVideoUrl, thumbnailUrl: finalThumbUrl, videoType
  };

  $("#status").textContent = "Publishing episode…";
  try {
    const r = await fetch("/api/episodes", { method: "POST", headers: { "content-type": "application/json", "x-admin-password": password }, body: JSON.stringify(payload) });
    const data = await r.json();
    if (!r.ok) return $("#status").textContent = data.error || "Publish failed.";
    $("#status").textContent = "Published successfully.";
    videoUrl = ""; thumbUrl = ""; r2VideoUrl = "";
    $("#videoStatus").textContent = "Not selected"; $("#thumbStatus").textContent = "Not selected"; $("#r2VideoStatus").textContent = "Not selected";
    $("#youtubeUrl").value = ""; $("#titleInput").value = ""; $("#durationInput").value = ""; $("#descriptionInput").value = "";
    load();
  } catch (err) { console.error(err); $("#status").textContent = "Network error. Please try again."; }
};

async function load() {
  try {
    const r = await fetch("/api/episodes");
    const items = await r.json();
    $("#adminGrid").innerHTML = items.length ? items.map(e => `<div class="admin-row"><div><strong>${esc(e.title)}</strong><span>Season ${e.season} · Episode ${e.episode}</span></div><button class="danger" data-id="${e.id}">Remove</button></div>`).join("") : '<p class="meta">No episodes yet.</p>';
    document.querySelectorAll(".danger").forEach(button => {
      button.onclick = async () => {
        if (!confirm("Remove this episode from the website?")) return;
        const password = $("#password").value.trim();
        const r = await fetch(`/api/episodes?id=${encodeURIComponent(button.dataset.id)}`, { method: "DELETE", headers: { "x-admin-password": password } });
        if (r.ok) load(); else { const d = await r.json(); alert(d.error || "Remove failed."); }
      };
    });
  } catch (e) { $("#adminGrid").innerHTML = '<p class="meta">Could not load episodes.</p>'; }
}
function esc(s) { return String(s || "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c])); }
load();
