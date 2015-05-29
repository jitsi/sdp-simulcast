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

function squeezeRemoteSimulcast(mLine) {

    if (!mLine || !Array.isArray(mLine.ssrcGroups)) {
        return;
    }

    var sources = parseSsrcs(mLine);

    // Find the SIM group and nuke it.
    mLine.ssrcGroups.some(function (simulcastGroup) {
        if (simulcastGroup.semantics !== 'SIM') {
            return false;
        }

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

        return true;
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
    var baseLayerSSRC = Object.keys(sources)[0];
    var baseLayer = sources[baseLayerSSRC];

    // todo(gp) handle screen sharing.

    // check if base CNAME has changed and reinitialise layers.
    if (this.layers.length > 0
        && sources[baseLayerSSRC].cname !== this.layers[0].cname) {
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
        mLine.ssrcs = writeSsrcs(sources);
    }
}

//endregion

//region "Public" functions

Simulcast.prototype.isSupported = function () {
    return window.chrome;

    // TODO this needs improvements. For example I doubt that Chrome in Android
    // has simulcast support. Also, only recent versions of Chromium have native
    // simulcast support.
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
            squeezeRemoteSimulcast(mLine);
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
