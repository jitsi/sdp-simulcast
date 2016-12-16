/* Copyright @ 2015 Atlassian Pty Ltd
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var transform = require('sdp-transform');
var transformUtils = require('./transform-utils');
var parseSsrcs = transformUtils.parseSsrcs;
var writeSsrcs = transformUtils.writeSsrcs;

//region Constants

var DEFAULT_NUM_OF_LAYERS = 3;

//endregion

//region Ctor

function Simulcast(options) {

    this.options = options ? options : {};

    if (!this.options.numOfLayers) {
        this.options.numOfLayers = DEFAULT_NUM_OF_LAYERS;
    }

    this.layers = [];
    
    // {
    //  ssrcInfos: [
    //      {
    //          ssrc: "",
    //          msid: "",
    //          cname: ""
    //      },
    //  ],
    //  ssrcGroups: [
    //      semantics: "",
    //      ssrcs: ""
    //  ]
    // }
    this.ssrcCache = {
        ssrcInfos: [],
        ssrcGroups: []
    };
}

//endregion

//region Stateless private utility functions

/**
 * Returns a random integer between min (included) and max (excluded)
 * Using Math.round() gives a non-uniform distribution!
 * @returns {number}
 */
function generateSSRC() {
    var min = 0, max = 0xffffffff;
    return Math.floor(Math.random() * (max - min)) + min;
};

function processVideo(session, action) {
    if (session == null || !Array.isArray(session.media)) {
        return;
    }

    session.media.forEach(function (mLine) {
        if (mLine.type === 'video') {
            action(mLine);
        }
    });
}

function validateDescription(desc)
{
    return desc && desc != null
        && desc.type && desc.type != ''
        && desc.sdp && desc.sdp != '';
}

function explodeRemoteSimulcast(mLine) {

    if (!mLine || !Array.isArray(mLine.ssrcGroups)) {
        return;
    }

    var sources = parseSsrcs(mLine);
    var order = [];

    // Find the SIM group and explode its sources.
    var j = mLine.ssrcGroups.length;
    while (j--) {

        if (mLine.ssrcGroups[j].semantics !== 'SIM') {
            continue;
        }

        var simulcastSsrcs = mLine.ssrcGroups[j].ssrcs.split(' ');

        for (var i = 0; i < simulcastSsrcs.length; i++) {

            var ssrc = simulcastSsrcs[i];
            order.push(ssrc);

            var parts = sources[ssrc].msid.split(' ');
            sources[ssrc].msid = [parts[0], '/', i, ' ', parts[1], '/', i].join('');
            sources[ssrc].cname = [sources[ssrc].cname, '/', i].join('');

            // Remove all the groups that this SSRC participates in.
            mLine.ssrcGroups.forEach(function (relatedGroup) {
                if (relatedGroup.semantics === 'SIM') {
                    return;
                }

                var relatedSsrcs = relatedGroup.ssrcs.split(' ');
                if (relatedSsrcs.indexOf(ssrc) === -1) {
                    return;
                }

                // Nuke all the related SSRCs.
                relatedSsrcs.forEach(function (relatedSSRC) {
                    sources[relatedSSRC].msid = sources[ssrc].msid;
                    sources[relatedSSRC].cname = sources[ssrc].cname;
                    if (relatedSSRC !== ssrc) {
                        order.push(relatedSSRC);
                    }
                });

                // Schedule the related group for nuking.
            })
        }

        mLine.ssrcs = writeSsrcs(sources, order);
        mLine.ssrcGroups.splice(j, 1);
    };
}

function implodeRemoteSimulcast(mLine) {

    if (!mLine || !Array.isArray(mLine.ssrcGroups)) {
        console.info('Halt: There are no SSRC groups in the remote ' +
                'description.');
        return;
    }

    var sources = parseSsrcs(mLine);

    // Find the SIM group and nuke it.
    mLine.ssrcGroups.forEach(function (simulcastGroup) {
        if (simulcastGroup.semantics !== 'SIM') {
            return;
        }

        console.info("Imploding SIM group: " + simulcastGroup.ssrcs);
        // Schedule the SIM group for nuking.
        simulcastGroup.nuke = true;

        var simulcastSsrcs = simulcastGroup.ssrcs.split(' ');

        // Nuke all the higher layer SSRCs.
        for (var i = 1; i < simulcastSsrcs.length; i++) {

            var ssrc = simulcastSsrcs[i];
            delete sources[ssrc];

            // Remove all the groups that this SSRC participates in.
            mLine.ssrcGroups.forEach(function (relatedGroup) {
                if (relatedGroup.semantics === 'SIM') {
                    return;
                }

                var relatedSsrcs = relatedGroup.ssrcs.split(' ');
                if (relatedSsrcs.indexOf(ssrc) === -1) {
                    return;
                }

                // Nuke all the related SSRCs.
                relatedSsrcs.forEach(function (relatedSSRC) {
                    delete sources[relatedSSRC];
                });

                // Schedule the related group for nuking.
                relatedGroup.nuke = true;
            })
        }

        return;
    });

    mLine.ssrcs = writeSsrcs(sources);

    // Nuke all the scheduled groups.
    var i = mLine.ssrcGroups.length;
    while (i--) {
        if (mLine.ssrcGroups[i].nuke) {
            mLine.ssrcGroups.splice(i, 1);
        }
    }
}

function removeGoogConference(mLine) {
    if (!mLine || !Array.isArray(mLine.invalid)) {
        return;
    }

    var i = mLine.invalid.length;
    while (i--) {
        if (mLine.invalid[i].value == 'x-google-flag:conference') {
            mLine.invalid.splice(i, 1);
        }
    }
}

function assertGoogConference(mLine) {
    if (!mLine) {
        return;
    }

    if (!Array.isArray(mLine.invalid)) {
        mLine.invalid = [];
    }

    if (!mLine.invalid.some(
            function (i) { return i.value === 'x-google-flag:conference' })) {
        mLine.invalid.push({'value': 'x-google-flag:conference'});
    }
}

//endregion

//region "Private" functions

Simulcast.prototype._generateSourceData = function(mLine, primarySsrc, doingRtx) {
    let getSsrcAttribute = (mLine, ssrc, attributeName) => {
        return mLine
            .ssrc
            .filter(ssrcInfo => ssrcInfo.id === ssrc)
            .filter(ssrcInfo => ssrcInfo.attribute === attributeName)
            .map(ssrcInfo => ssrcInfo.value)[0];
    };
    let addAssociatedStream = (mLine, ssrc) => {
        mLine.ssrcs.push({
            id: ssrc,
            attribute: "cname",
            value: primarySsrcCname;
        });
        mLine.ssrcs.push({
            id: ssrc,
            attribute: "msid",
            value: primarySsrcMsid;
        });
    }
    let primarySsrcMsid = getSsrcAttribute(mLine, primarySsrc, "msid");
    let primarySsrcCname = getSsrcAttribute(mLine, primarySsrc, "cname");

    // Generate 2 sim layers
    let simSsrcs = [];
    for (let i = 0; i < 2; ++i) {
        let simSsrc = generateSSRC();
        addAssociatedStream(simSsrc);
        simSsrcs.push(simSsrc);
    }
    mLine.ssrcGroups.push({
        semantics: "SIM",
        ssrcs: primarySsrc + simSsrcs.join(" ");
    });

    if (doingRtx) {
        // Generate rtx streams and groups for the created sim
        //  streams
        simSsrcs.forEach(function(simSsrc) {
            let rtxSsrc = generateSSRC();
            addAssociatedStream(rtxSsrc);
            mLine.ssrcGroups.push({
                semantics: "FID",
                ssrcs: primarySsrc + " " + rtxSsrc
            });
        });
    }
}



// Assumptions:
//  1) 'mLine' contains only a single primary video source
//   (i.e. it will not already have simulcast streams inserted)
//  2) 'mLine' MAY already contain an RTX stream for its video source
//  3) 'mLine' is in sendrecv or sendonly state
// Guarantees:
//  1) return mLine will contain 2 additional simulcast layers
//   generated
//  2) if the base video ssrc in mLine has been seen before,
//   then the same generated simulcast streams from before will
//   be used again
//  3) if rtx is enabled for the mLine, all generated simulcast
//   streams will have rtx streams generated as well
//  4) if rtx has been generated for a src before, we will generate
//   the same rtx stream again
Simulcast.prototype._restoreSimulcast = function(mLine) {
    // First, find the primary video source in the given
    // mLine and see if we've seen it before.
    var primarySsrc;
    var numSsrcs = mLine.ssrcs.length;
    var numGroups = (mLine.ssrcGroups && mLine.ssrcGroups.length) || 0;

    if (numSsrcs === 0 || numSsrcs > 2) {
        // Unsupported scenario
        return mLine;
    }
    if (mLine.ssrcs.length == 2 && numGroups === 0) {
        // Unsupported scenario
        return mLine;
    }

    let doingRtx = false;
    if (numSsrcs === 1) {
        primarySsrc = mLine.ssrcs[0];
    } else {
        // There must be an FID group, so parse
        //  that and pull the primary ssrc from there
        let fidGroup = mLine.ssrcGroups.filter(group => group.semantics === "FID")[0];
        primarySsrc = fidGroup.ssrcs.split(" ")[0];
        doingRtx = true;
    }
    console.log("BB: parsed primary ssrc " + primarySsrc);

    let seenPrimarySsrc = 
        ssrcCache
        .ssrcs
        .map(ssrcInfo => ssrcInfo.ssrc)
        .some(ssrc => ssrc === primarySsrc);

    if (seenPrimarySsrc) {
        //TODO: fillInDataFromCache(mLine, primarySsrc, doingRtx);
    } else {
        //TODO: generateData(mLine, primarySsrc, doingRtx);
    }
        

    let seenPrimarySsrcInfo = ssrcCache.ssrcs
        .map(ssrcInfo => ssrcInfo.ssrc)
        .filter(ssrc => ssrc === primarySsrc)[0];
    if (seenPrimarySsrcInfo) {
        console.log("BB: we've seen this primary ssrc before, will try to use existing mappings");
        let existingSimGroup = ssrcCache.ssrcGroups
            .filter(group => group.semantics === "SIM")[0];
        if (existingSimGroup) {
            console.log("BB: have an existing SIM group for this ssrc, will re-use ssrcs for other layers");
            let oldSimSsrcs = existingSimGroup.ssrcs.split(" ");
            // Purposefully skip the base layer since 
            //  it's already in the mLine
            for (let i = 1; i < oldSimSsrcs.length; ++i) {
                mLine.ssrcs.push({
                    id: oldSimSsrcs[i],
                    attribute: "cname",
                    value: seenPrimarySsrcInfo.cname;
                });
                mLine.ssrcs.push({
                    id: oldSimSsrcs[i],
                    attribute: "msid",
                    value: seenPrimarySsrcInfo.msid;
                });
            }
        } else {
            console.log("BB: we've seen this primary ssrc before, but have no existing sim group for it => shouldn't happen");
        }
        if (Array.isArray(mLine.rtp) && 
            mLine.rtp.some(rtpmap => rtpmap.codec === 'rtx')) {
            // 
        } else {
            // No rtx in sdp, clear out any cached rtx information
            // TODO
        }
        // if (mline has rtx)
        //   if (existing rtx mapping)
        //     apply existing rtx mapping
        //   else
        //      generate new rtx
        // else
        //   if (have existing rtx mapping)
        //     error? just get rid of the mapping?
    } else {
        console.log("BB: haven't seen this primary ssrc before, will wipe cache and generate new ssrcs");
        // clear any cached ssrc information
        // generate 2 ssrcs for sim layers
        // if (rtx) { generate rtx for each sim layer }
    }
}

/**
 *
 * @param mLine
 * @private
 */
Simulcast.prototype._maybeInitializeLayers = function(mLine) {

    if (!mLine || mLine.type !== 'video') {
        return;
    }

    var sources = parseSsrcs(mLine);

    if (Object.keys(sources).length === 0) {

        // no sources, disable simulcast.
        if (this.layers.length !== 0) {
            this.layers = [];
        }

        return;
    }

    // find the base layer (we'll reuse its msid and cname).
    var baseLayerSSRC;
    // If we have stored layers the first one is the base layer, but pick it
    // only if it's SSRC still exists in local description. If not then
    // the layers will be reinitialized(baseline SSRCs will not match).
    if (this.layers.length > 0 && sources[this.layers[0].ssrc]) {
        baseLayerSSRC = this.layers[0].ssrc;
    } else {
        // FIXME Picking first key is ok only if there is 1 SSRC, otherwise
        // Object keys will be sorted in ascending order. Usually this is
        // the initialization case when there are no layers.
        // Object.keys() returns string
        baseLayerSSRC = parseInt(Object.keys(sources)[0]);
    }
    var baseLayer = sources[baseLayerSSRC];

    // todo(gp) handle screen sharing.

    // check if base CNAME or SSRC has changed and reinitialise layers.
    if (this.layers.length > 0
        && (baseLayer.cname !== this.layers[0].cname ||
            baseLayerSSRC !== this.layers[0].ssrc)) {
        this.layers = [];
    }

    // (re)initialise layers
    if (this.layers.length < 1) {

        // first push the base layer.
        this.layers.push({
            ssrc: baseLayerSSRC,
            msid: baseLayer.msid,
            cname: baseLayer.cname
        });

        var rtx = false; // RFC 4588
        if (Array.isArray(mLine.rtp)) {
            rtx = mLine.rtp.some(
                function (rtpmap) { return rtpmap.codec === 'rtx'; });
        }

        if (rtx) {
            this.layers[0].rtx = generateSSRC();
        }

        // now push additional layers.
        for (var i = 1; i < Math.max(1, this.options.numOfLayers); i++) {

            var layer = { ssrc: generateSSRC() };
            if (rtx) {
                layer.rtx = generateSSRC();
            }

            this.layers.push(layer);
        }
    }
};

/**
 *
 * @param mLine
 * @private
 */
Simulcast.prototype._restoreSimulcastView = function(mLine) {
    if (mLine && mLine.type === 'video' && this.layers.length !== 0) {

        var sources = {};

        var msid = this.layers[0].msid;
        var cname = this.layers[0].cname;
        var simulcastSsrcs = [];
        var ssrcGroups = [];

        for (var i = 0; i < this.layers.length; i++) {
            var layer = this.layers[i];

            sources[layer.ssrc] = { msid: msid, cname: cname };
            simulcastSsrcs.push(layer.ssrc);

            if (layer.rtx) {

                sources[layer.rtx] = {
                    msid: msid,
                    cname: cname
                }

                ssrcGroups.push({
                    semantics: 'FID',
                    ssrcs: [layer.ssrc, layer.rtx].join(' ')
                });
            }
        }

        ssrcGroups.push({
            semantics: 'SIM',
            ssrcs: simulcastSsrcs.join(' ')
        });

        mLine.ssrcGroups = ssrcGroups;
        mLine.ssrcs = writeSsrcs(sources, simulcastSsrcs);
    }
}

//endregion

//region "Public" functions

Simulcast.prototype.isSupported = function () {
    return !!window.chrome;

    // TODO this needs improvements. For example I doubt that Chrome in Android
    // has simulcast support.
    // Think about just removing this, since the user of the library is probably
    // in a better position to know what browser it is running in and
    // whether simulcast should be used.
}

/**
 *
 * @param desc
 * @returns {RTCSessionDescription}
 */
Simulcast.prototype.mungeRemoteDescription = function (desc) {

    if (!validateDescription(desc)) {
        return desc;
    }

    var session = transform.parse(desc.sdp);

    var self = this;
    processVideo(session, function (mLine) {

        // Handle simulcast reception.
        if (self.options.explodeRemoteSimulcast) {
            explodeRemoteSimulcast(mLine);
        } else {
            implodeRemoteSimulcast(mLine);
        }

        // If native simulcast is enabled, we must append the x-goog-conference
        // attribute to the SDP.
        if (self.layers.length < 1) {
            removeGoogConference(mLine);
        } else {
            assertGoogConference(mLine);
        }
    });

    return new RTCSessionDescription({
        type: desc.type,
        sdp: transform.write(session)
    });
};

/**
 *
 * @param desc
 * @returns {RTCSessionDescription}
 */
Simulcast.prototype.mungeLocalDescription = function (desc) {

    if (!validateDescription(desc) || !this.isSupported()) {
        return desc;
    }

    var session = transform.parse(desc.sdp);

    var self = this;
    processVideo(session, function (mLine) {
        if (mLine.direction == 'recvonly' || mLine.direction == 'inactive')
        {
            return;
        }
        // Initialize native simulcast layers, if not already done.
        self._maybeInitializeLayers(mLine);

        // Update the SDP with the simulcast layers.
        self._restoreSimulcastView(mLine);
    });

    return new RTCSessionDescription({
        type: desc.type,
        sdp: transform.write(session)
    });
};

//endregion

module.exports = Simulcast;
