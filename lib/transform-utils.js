exports.writeSsrcs = function(sources, order) {
  var ssrcs = [];

  // expand sources to ssrcs
  if (typeof sources !== 'undefined' &&
      Object.keys(sources).length !== 0) {

    if (Array.isArray(order)) {
      for (var i = 0; i < order.length; i++) {
        var ssrc = order[i];
        var source = sources[ssrc];
        Object.keys(source).forEach(function (attribute) {
          ssrcs.push({
            id: ssrc,
            attribute: attribute,
            value: source[attribute]
          });
        });
      }
    } else {
      Object.keys(sources).forEach(function (ssrc) {
        var source = sources[ssrc];
        Object.keys(source).forEach(function (attribute) {
          ssrcs.push({
            id: ssrc,
            attribute: attribute,
            value: source[attribute]
          });
        });
      });
    }
  }

  return ssrcs;
};

exports.parseSsrcs = function (mLine) {
  var sources = {};
  // group sources attributes by ssrc.
  if (typeof mLine.ssrcs !== 'undefined' && Array.isArray(mLine.ssrcs)) {
    mLine.ssrcs.forEach(function (ssrc) {
      if (!sources[ssrc.id])
        sources[ssrc.id] = {};
      sources[ssrc.id][ssrc.attribute] = ssrc.value;
    });
  }
  return sources;
};

