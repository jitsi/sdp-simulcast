var Simulcast = require("./index.js");
var SampleSdps = require("./SampleSdpStrings.js");
var transform = require("sdp-transform");

var numVideoSsrcs = function (parsedSdp) {
  let videoMLine = parsedSdp.media.find(m => m.type === "video");
  return videoMLine.ssrcs
    .map(ssrcInfo => ssrcInfo.id)
    .filter((ssrc, index, array) => array.indexOf(ssrc) === index)
    .length;
};

var getVideoGroups = function (parsedSdp, groupSemantics) {
    var videoMLine = parsedSdp.media.find(m => m.type === "video");
    videoMLine.ssrcGroups = videoMLine.ssrcGroups || [];
    return videoMLine.ssrcGroups
      .filter(function(g) { return g.semantics === groupSemantics; });
};

describe("sdp-simulcast", function() {
  beforeEach(function() {
    this.numLayers = 3;
    this.simulcast = new Simulcast({
      numOfLayers: this.numLayers,
    });
    this.transform = transform;
  });
  
  it ("should add simulcast layers to the sdp", function() {
    var sdp = SampleSdps.plainVideoSdp;
    var desc = {
      type: "answer",
      sdp: transform.write(sdp),
    };

    var newDesc = this.simulcast.mungeLocalDescription(desc);
    var newSdp = transform.parse(newDesc.sdp);
    expect(numVideoSsrcs(newSdp)).toEqual(this.numLayers);
    let simGroups = getVideoGroups(newSdp, "SIM");
    expect(simGroups.length).toEqual(1);
    let simGroup = simGroups[0];
    expect(simGroup.ssrcs.split(" ").length).toEqual(this.numLayers);
  });

  describe("corner cases", function() {
    it ("should do nothing if the mline has no ssrcs", function() {
      var sdp = SampleSdps.plainVideoSdp;
      var videoMLine = sdp.media.find(function(m) { return m.type === "video"; });
      videoMLine.ssrcs = [];
      var desc = {
        type: "answer",
        sdp: transform.write(sdp)
      }

      var newDesc = this.simulcast.mungeLocalDescription(desc);
    });
  });
});
