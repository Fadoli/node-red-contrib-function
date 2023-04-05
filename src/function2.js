/**
 * Copyright JS Foundation and other contributors, http://js.foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 **/

module.exports = function (RED) {
    "use strict";

    var util = require("util");
    var vm = require("vm");
    var acorn = require("acorn");
    var acornWalk = require("acorn-walk");

    function sendResults(node, send, _msgid, msgs, cloneFirstMessage) {
        if (msgs == null) {
            return;
        } else if (!util.isArray(msgs)) {
            msgs = [msgs];
        }
        var msgCount = 0;
        for (var m = 0; m < msgs.length; m++) {
            if (msgs[m]) {
                if (!util.isArray(msgs[m])) {
                    msgs[m] = [msgs[m]];
                }
                for (var n = 0; n < msgs[m].length; n++) {
                    var msg = msgs[m][n];
                    if (msg !== null && msg !== undefined) {
                        if (typeof msg === 'object' && !Buffer.isBuffer(msg) && !util.isArray(msg)) {
                            if (msgCount === 0 && cloneFirstMessage !== false) {
                                msgs[m][n] = RED.util.cloneMessage(msgs[m][n]);
                                msg = msgs[m][n];
                            }
                            msg._msgid = _msgid;
                            msgCount++;
                        } else {
                            var type = typeof msg;
                            if (type === 'object') {
                                type = Buffer.isBuffer(msg) ? 'Buffer' : (util.isArray(msg) ? 'Array' : 'Date');
                            }
                            node.error(RED._("function.error.non-message-returned", { type: type }));
                        }
                    }
                }
            }
        }
        if (msgCount > 0) {
            send(msgs);
        }
    }

    function createVMOpt(node, kind) {
        var opt = {
            filename: 'Function node' + kind + ':' + node.id + (node.name ? ' [' + node.name + ']' : ''), // filename for stack traces
            displayErrors: true
            // Using the following options causes node 4/6 to not include the line number
            // in the stack output. So don't use them.
            // lineOffset: -11, // line number offset to be used for stack traces
            // columnOffset: 0, // column number offset to be used for stack traces
        };
        return opt;
    }

    function updateErrorInfo(err) {
        if (err.stack) {
            var stack = err.stack.toString();
            var m = /^([^:]+):([^:]+):(\d+).*/.exec(stack);
            if (m) {
                var line = parseInt(m[3]) - 1;
                var kind = "body:";
                if (/setup/.exec(m[1])) {
                    kind = "setup:";
                }
                if (/cleanup/.exec(m[1])) {
                    kind = "cleanup:";
                }
                err.message += " (" + kind + "line " + line + ")";
            }
        }
    }

    function FunctionNode(n) {
        RED.nodes.createNode(this, n);
        var node = this;
        node.name = n.name;
        node.func = n.func;
        node.outputs = n.outputs;
        node.ini = n.initialize ? n.initialize.trim() : "";
        node.fin = n.finalize ? n.finalize.trim() : "";
        node.libs = n.libs || [];

        if (RED.settings.function2ExternalModules === false && node.libs.length > 0) {
            throw new Error(RED._("function.error.externalModuleNotAllowed"));
        }

        const functionText = `var results = async (msg,send,done) => {
    node.send = function(msgs,cloneMsg){ node._send(send,msg._msgid,msgs,cloneMsg);};
    node.done = done;
    ${node.func}
}`;

        var handleNodeDoneCall = true;

        // Check to see if the Function appears to call `node.done()`. If so,
        // we will assume it is well written and does actually call node.done().
        // Otherwise, we will call node.done() after the function returns regardless.
        if (false && /node\.done\s*\(\s*\)/.test(functionText)) {
            // We have spotted the code contains `node.done`. It could be in a comment
            // so need to do the extra work to parse the AST and examine it properly.
            acornWalk.simple(acorn.parse(functionText, { ecmaVersion: "latest" }), {
                CallExpression(astNode) {
                    if (astNode.callee && astNode.callee.object) {
                        if (astNode.callee.object.name === "node" && astNode.callee.property.name === "done") {
                            handleNodeDoneCall = false;
                        }
                    }
                }
            })
        }

        var finScript = null;
        var finOpt = null;
        node.topic = n.topic;
        node.outstandingTimers = [];
        node.outstandingIntervals = [];
        node.clearStatus = false;

        var sandbox = {
            console: console,
            util: util,
            Buffer: Buffer,
            Date: Date,
            RED: {
                util: { ...RED.util }
            },
            node: {
                id: node.id,
                name: node.name,
                path: node._path,
                outputCount: node.outputs,
                log: function () {
                    node.log.apply(node, arguments);
                },
                error: function () {
                    node.error.apply(node, arguments);
                },
                warn: function () {
                    node.warn.apply(node, arguments);
                },
                debug: function () {
                    node.debug.apply(node, arguments);
                },
                trace: function () {
                    node.trace.apply(node, arguments);
                },
                _send: function (send, id, msgs, cloneMsg) {
                    sendResults(node, send, id, msgs, cloneMsg);
                },
                on: function () {
                    if (arguments[0] === "input") {
                        throw new Error(RED._("function.error.inputListener"));
                    }
                    node.on.apply(node, arguments);
                },
                status: function () {
                    node.clearStatus = true;
                    node.status.apply(node, arguments);
                }
            },
            context: {
                set: function () {
                    node.context().set.apply(node, arguments);
                },
                get: function () {
                    return node.context().get.apply(node, arguments);
                },
                keys: function () {
                    return node.context().keys.apply(node, arguments);
                },
                get global() {
                    return node.context().global;
                },
                get flow() {
                    return node.context().flow;
                }
            },
            flow: {
                set: function () {
                    node.context().flow.set.apply(node, arguments);
                },
                get: function () {
                    return node.context().flow.get.apply(node, arguments);
                },
                keys: function () {
                    return node.context().flow.keys.apply(node, arguments);
                }
            },
            global: {
                set: function () {
                    node.context().global.set.apply(node, arguments);
                },
                get: function () {
                    return node.context().global.get.apply(node, arguments);
                },
                keys: function () {
                    return node.context().global.keys.apply(node, arguments);
                }
            },
            env: {
                get: function (envVar) {
                    return RED.util.getSetting(node, envVar);
                }
            },
            setTimeout: function () {
                var func = arguments[0];
                var timerId;
                arguments[0] = function () {
                    sandbox.clearTimeout(timerId);
                    try {
                        func.apply(node, arguments);
                    } catch (err) {
                        node.error(err, {});
                    }
                };
                timerId = setTimeout.apply(node, arguments);
                node.outstandingTimers.push(timerId);
                return timerId;
            },
            clearTimeout: function (id) {
                clearTimeout(id);
                var index = node.outstandingTimers.indexOf(id);
                if (index > -1) {
                    node.outstandingTimers.splice(index, 1);
                }
            },
            setInterval: function () {
                var func = arguments[0];
                var timerId;
                arguments[0] = function () {
                    try {
                        func.apply(node, arguments);
                    } catch (err) {
                        node.error(err, {});
                    }
                };
                timerId = setInterval.apply(node, arguments);
                node.outstandingIntervals.push(timerId);
                return timerId;
            },
            clearInterval: function (id) {
                clearInterval(id);
                var index = node.outstandingIntervals.indexOf(id);
                if (index > -1) {
                    node.outstandingIntervals.splice(index, 1);
                }
            }
        };
        if (util.hasOwnProperty('promisify')) {
            sandbox.setTimeout[util.promisify.custom] = function (after, value) {
                return new Promise(function (resolve, reject) {
                    sandbox.setTimeout(function () { resolve(value); }, after);
                });
            };
            sandbox.promisify = util.promisify;
        }
        const moduleLoadPromises = [];

        if (node.hasOwnProperty("libs")) {
            let moduleErrors = false;
            var modules = node.libs;
            modules.forEach(module => {
                var vname = module.hasOwnProperty("var") ? module.var : null;
                if (vname && (vname !== "")) {
                    if (sandbox.hasOwnProperty(vname) || vname === 'node') {
                        node.error(RED._("function.error.moduleNameError", { name: vname }))
                        moduleErrors = true;
                        return;
                    }
                    sandbox[vname] = null;
                    var spec = module.module;
                    if (spec && (spec !== "")) {
                        moduleLoadPromises.push(RED.import(module.module).then(lib => {
                            sandbox[vname] = lib.default;
                        }).catch(err => {
                            node.error(RED._("function.error.moduleLoadError", { module: module.spec, error: err.toString() }))
                            throw err;
                        }));
                    }
                }
            });
            if (moduleErrors) {
                throw new Error(RED._("function.error.externalModuleLoadError"));
            }
        }
        const RESOLVING = 0;
        const RESOLVED = 1;
        const ERROR = 2;
        var state = RESOLVING;
        var messages = [];
        var processMessage = (() => { });

        node.on("input", function (msg, send, done) {
            if (state === RESOLVING) {
                messages.push({ msg: msg, send: send, done: done });
            }
            else if (state === RESOLVED) {
                processMessage(msg, send, done);
            }
        });
        Promise.all(moduleLoadPromises).then(() => {
            var context = vm.createContext(sandbox);
            try {
                var iniScript = null;
                var iniOpt = null;
                if (node.ini && (node.ini !== "")) {
                    var iniText = `
                        (async function() {
                            node.send = function(msgs,cloneMsg){ node._send(__send__, RED.util.generateId(), msgs, cloneMsg); };
                            `+ node.ini + `
                        })();`;
                    iniOpt = createVMOpt(node, " setup");
                    iniScript = new vm.Script(iniText, iniOpt);
                }
                node.script = vm.createScript(functionText, createVMOpt(node, ""));
                node.script.runInContext(context);
                const functionProcess = context.results;

                if (node.fin && (node.fin !== "")) {
                    var finText = "(function () {\n" +
                        node.fin +
                        "\n})();";
                    finOpt = createVMOpt(node, " cleanup");
                    finScript = new vm.Script(finText, finOpt);
                }
                var promise = Promise.resolve();
                if (iniScript) {
                    context.__send__ = function (msgs) { node.send(msgs); };
                    promise = iniScript.runInContext(context, iniOpt);
                }

                const needTime = process.env.NODE_RED_FUNCTION_TIME;
                const hasMetrics = node.metric();

                processMessage = function (msg, send, done) {
                    var start = process.hrtime();

                    functionProcess(msg, send, done).then(function (results) {
                        sendResults(node, send, msg._msgid, results, false);
                        if (handleNodeDoneCall) {
                            done();
                        }

                        if (needTime || hasMetrics) {
                            var duration = process.hrtime(start);
                            var converted = Math.floor((duration[0] * 1e9 + duration[1]) / 10000) / 100;
                            if (needTime) {
                                node.status({ fill: "yellow", shape: "dot", text: "" + converted });
                            } else {
                                node.metric("duration", msg, converted);
                            }
                        }
                    }).catch(err => {
                        if (err && err.stack) {
                            let errorData = err.stack.split('at results')[1].split(')')[0].split(':');
                            // Offset due to code
                            const lineNumber = errorData[errorData.length - 2] - 3;
                            const charNumber = errorData[errorData.length - 1];
                            done(`${err.toString()} (line ${lineNumber}, col ${charNumber})`);
                        }
                        else if (typeof err === "string") {
                            done(err);
                        }
                        else {
                            done(JSON.stringify(err));
                        }
                    });
                }

                node.on("close", function () {
                    if (finScript) {
                        try {
                            finScript.runInContext(context, finOpt);
                        }
                        catch (err) {
                            node.error(err);
                        }
                    }
                    while (node.outstandingTimers.length > 0) {
                        clearTimeout(node.outstandingTimers.pop());
                    }
                    while (node.outstandingIntervals.length > 0) {
                        clearInterval(node.outstandingIntervals.pop());
                    }
                    if (node.clearStatus) {
                        node.status({});
                    }
                });

                promise.then(function (v) {
                    var msgs = messages;
                    messages = [];
                    while (msgs.length > 0) {
                        msgs.forEach(function (s) {
                            processMessage(s.msg, s.send, s.done);
                        });
                        msgs = messages;
                        messages = [];
                    }
                    state = RESOLVED;
                }).catch((error) => {
                    messages = [];
                    state = ERROR;
                    node.error(error);
                });

            }
            catch (err) {
                // eg SyntaxError - which v8 doesn't include line number information
                // so we can't do better than this
                updateErrorInfo(err);
                node.error(err);
            }
        }).catch(err => {
            node.error(RED._("function.error.externalModuleLoadError"));
        });
    }
    RED.nodes.registerType("function2", FunctionNode, {
        dynamicModuleList: "libs",
        settings: {
            function2ExternalModules: { value: true, exportable: true }
        }
    });
    RED.library.register("functions");
};
