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

