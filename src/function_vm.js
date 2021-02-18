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

module.exports = function(RED) {
    const util = require("util");
    const vm = require("vm");
    "use strict";

    const common = require('./common');
    common.init(RED);
    const sendResults = common.sendResults;
    const updateErrorInfo = common.updateErrorInfo;

    function createVMOpt(node, kind) {
        var opt = {
            filename: 'Function node'+kind+':'+node.id+(node.name?' ['+node.name+']':''), // filename for stack traces
            displayErrors: true
            // Using the following options causes node 4/6 to not include the line number
            // in the stack output. So don't use them.
            // lineOffset: -11, // line number offset to be used for stack traces
            // columnOffset: 0, // column number offset to be used for stack traces
        };
        return opt;
    }

    function FunctionNode(n) {
        RED.nodes.createNode(this,n);
        var node = this;
        node.name = n.name;
        node.func = n.func;
        node.ini = n.initialize ? n.initialize.trim() : "";
        node.fin = n.finalize ? n.finalize.trim() : "";

        var handleNodeDoneCall = true;

        // Check to see if the Function appears to call `node.done()`. If so,
        // we will assume it is well written and does actually call node.done().
        // Otherwise, we will call node.done() after the function returns regardless.
        if (/node\.done\s*\(\s*\)/.test(node.func)) {
            handleNodeDoneCall = false;
        }

        const functionText = 
`var results = async (msg,send,done) => {
    node.send = function(msgs,cloneMsg){ node._send(send,msg._msgid,msgs,cloneMsg);};
    node.done = done;
    ${node.func}
}`;
        var finScript = null;
        var finOpt = null;
        node.topic = n.topic;
        node.outstandingTimers = [];
        node.outstandingIntervals = [];
        node.clearStatus = false;

        const sandbox = {
            console:console,
            util:util,
            Buffer:Buffer,
            Date: Date,
            RED: {
                util: {... RED.util}
            },
            node: {
                id: node.id,
                name: node.name,
                log: function() {
                    node.log.apply(node, arguments);
                },
                error: function() {
                    node.error.apply(node, arguments);
                },
                warn: function() {
                    node.warn.apply(node, arguments);
                },
                debug: function() {
                    node.debug.apply(node, arguments);
                },
                trace: function() {
                    node.trace.apply(node, arguments);
                },
                _send: function(send, id, msgs, cloneMsg) {
                    sendResults(node, send, id, msgs, cloneMsg);
                },
                on: function() {
                    if (arguments[0] === "input") {
                        throw new Error(RED._("function.error.inputListener"));
                    }
                    node.on.apply(node, arguments);
                },
                status: function() {
                    node.clearStatus = true;
                    node.status.apply(node, arguments);
                }
            },
            context: {
                set: function() {
                    node.context().set.apply(node,arguments);
                },
                get: function() {
                    return node.context().get.apply(node,arguments);
                },
                keys: function() {
                    return node.context().keys.apply(node,arguments);
                },
                get global() {
                    return node.context().global;
                },
                get flow() {
                    return node.context().flow;
                }
            },
            flow: {
                set: function() {
                    node.context().flow.set.apply(node,arguments);
                },
                get: function() {
                    return node.context().flow.get.apply(node,arguments);
                },
                keys: function() {
                    return node.context().flow.keys.apply(node,arguments);
                }
            },
            global: {
                set: function() {
                    node.context().global.set.apply(node,arguments);
                },
                get: function() {
                    return node.context().global.get.apply(node,arguments);
                },
                keys: function() {
                    return node.context().global.keys.apply(node,arguments);
                }
            },
            env: {
                get: function(envVar) {
                    var flow = node._flow;
                    return flow.getSetting(envVar);
                }
            },
            setTimeout: function () {
                var func = arguments[0];
                var timerId;
                arguments[0] = function() {
                    sandbox.clearTimeout(timerId);
                    try {
                        func.apply(node,arguments);
                    } catch(err) {
                        node.error(err,{});
                    }
                };
                timerId = setTimeout.apply(node,arguments);
                node.outstandingTimers.push(timerId);
                return timerId;
            },
            clearTimeout: function(id) {
                clearTimeout(id);
                var index = node.outstandingTimers.indexOf(id);
                if (index > -1) {
                    node.outstandingTimers.splice(index,1);
                }
            },
            setInterval: function() {
                var func = arguments[0];
                var timerId;
                arguments[0] = function() {
                    try {
                        func.apply(node,arguments);
                    } catch(err) {
                        node.error(err,{});
                    }
                };
                timerId = setInterval.apply(node,arguments);
                node.outstandingIntervals.push(timerId);
                return timerId;
            },
            clearInterval: function(id) {
                clearInterval(id);
                var index = node.outstandingIntervals.indexOf(id);
                if (index > -1) {
                    node.outstandingIntervals.splice(index,1);
                }
            }
        };
        if (util.hasOwnProperty('promisify')) {
            sandbox.setTimeout[util.promisify.custom] = function(after, value) {
                return new Promise(function(resolve, reject) {
                    sandbox.setTimeout(function(){ resolve(value); }, after);
                });
            };
            sandbox.promisify = util.promisify;
        }
        const context = vm.createContext(sandbox);
        try {
            var iniScript = null;
            var iniOpt = null;
            if (node.ini) {
                var iniText = `
                    (async function() {
                        node.send = function(msgs,cloneMsg){ node._send(__send__, RED.util.generateId(), msgs, cloneMsg); };
                        `+ node.ini +`
                    })();`;
                iniOpt = createVMOpt(node, " setup");
                iniScript = new vm.Script(iniText, iniOpt);
            }
            
            node.script = new vm.Script(functionText, createVMOpt(node, ""));
            let functionProcess;
            try {
                node.script.runInContext(context);
                functionProcess = context.results;
            } catch (e) {
                console.log(functionText);
                console.error(e);
            }

            if (node.fin) {
                var finText = "(function () {\n"+
                node.fin +
                "\n})();";
                finOpt = createVMOpt(node, " cleanup");
                finScript = new vm.Script(finText, finOpt);
            }
            var promise = Promise.resolve();
            
            if (iniScript) {
                context.__send__ = function(msgs) { node.send(msgs); };
                promise = iniScript.runInContext(context);
            }

            function processMessage(msg, send, done) {
                var start = process.hrtime();
                
                functionProcess(msg,send,done).then(function(results) {
                    sendResults(node,send,msg._msgid,results,false);
                    if (handleNodeDoneCall) {
                        done();
                    }

                    var duration = process.hrtime(start);
                    var converted = Math.floor((duration[0] * 1e9 + duration[1])/10000)/100;
                    node.metric("duration", msg, converted);
                    if (process.env.NODE_RED_FUNCTION_TIME) {
                        node.status({fill:"yellow",shape:"dot",text:""+converted});
                    }
                }).catch(err => {
                    if (err && err.stack) {
                        //remove unwanted part
                        const stacks = err.stack.split('\n');
                        let errorData = [];
                        stacks.forEach(rawline => {
                            line = rawline.trim();
                            if (line.indexOf('results') === -1) {
                                return;
                            }
                            errorData = line.split(':');
                        });
                        console.log(errorData);
                        // Offset due to code
                        const lineNumber = errorData[errorData.length-2] - 3;
                        const charNumber = errorData[errorData.length-1].slice(0,-1);
                        errorMessage = `${stacks[0]} (line ${lineNumber}, col ${charNumber})`;

                        done(errorMessage);
                    }
                    else if (typeof err === "string") {
                        done(err);
                    }
                    else {
                        done(JSON.stringify(err));
                    }
                });
            }

            const RESOLVING = 0;
            const RESOLVED = 1;
            const ERROR = 2;
            var state = RESOLVING;
            var messages = [];

            node.on("input", function(msg,send,done) {
                if(state === RESOLVING) {
                    messages.push({msg:msg, send:send, done:done});
                }
                else if(state === RESOLVED) {
                    processMessage(msg, send, done);
                }
            });
            node.on("close", function() {
                if (finScript) {
                    try {
                        finScript.runInContext(context);
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
        catch(err) {
            // eg SyntaxError - which v8 doesn't include line number information
            // so we can't do better than this
            updateErrorInfo(err);
            node.error(err);
        }
    }
    RED.nodes.registerType("function_vm",FunctionNode);
};

