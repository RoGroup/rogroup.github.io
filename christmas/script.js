var audioPlayer = new Audio(radioStreamLink),
  isPlaying = !1,
  isVolOpen = !1,
  ctx = new AudioContext(),
  audioSrc = ctx.createMediaElementSource(audioPlayer),
  analyser = ctx.createAnalyser();
audioSrc.connect(analyser), audioSrc.connect(ctx.destination);
var frequencyData = new Uint8Array(analyser.frequencyBinCount),
  volumeSlider = document.getElementById("volslider");
function playPauseClick() {
  isPlaying ? (pause(), (isPlaying = !1)) : (play(), (isPlaying = !0));
}
function play() {
  (document.getElementById("playpause").innerHTML =
    '<i class="fa fa-pause-circle"></i>'),
    (audioPlayer = new Audio(
      radioStreamLink + "?t=" + Math.floor(Date.now() / 1e3)
    )),
    (ctx = new AudioContext()),
    (audioSrc = ctx.createMediaElementSource(audioPlayer)),
    (analyser = ctx.createAnalyser()),
    audioSrc.connect(analyser),
    audioSrc.connect(ctx.destination),
    (frequencyData = new Uint8Array(analyser.frequencyBinCount)),
    (audioPlayer.crossOrigin = "anonymous"),
    audioPlayer.play();
}
function pause() {
  (document.getElementById("playpause").innerHTML =
    '<i class="fa fa-play-circle"></i>'),
    audioPlayer.pause();
}
function updateStats() {
  $.get(
    "" +
      new Date().getTime(),
    a => {
      let {
        now_playing: np,
        live: { streamer_name: dj, is_live: live },
        listeners: { unique: listeners }
      } = a;
      let { song } = np;
      $("#dj").html(live ? "DJ " + dj : "Gravity Stream");
      $("#djmessage").html("Broken rn");
      $("#listeners").html(`${listeners} listeners`);
      console.log(`${song.title} - ${song.artist}`);
      $("#song").html(`${song.title}`);
      $("#artist").html(`${song.artist}`);
    }
  );
}

updateStats();



setInterval(updateStats, 5 * 1000);

(audioPlayer.crossOrigin = "anonymous"),
  (volumeSlider.oninput = function() {
    audioPlayer.volume = this.value / 100;
  }),
  updateStats(),


  renderFrame();
