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
    const vm = require("vm2");
    "use strict";
    
    const common = require('./common');
    common.init(RED);
    const sendResults = common.sendResults;
    const updateErrorInfo = common.updateErrorInfo;
    
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
`
const global = _global;
const node = {
    id:__node__.id,
    name:__node__.name,
    log:__node__.log,
    error:__node__.error,
    warn:__node__.warn,
    debug:__node__.debug,
    trace:__node__.trace,
    on:__node__.on,
    status:__node__.status
}
return async function (msg,send,done) {
    node.send = function(msgs,cloneMsg){ __node__.send(send,msg._msgid,msgs,cloneMsg);};
    node.done = done;
    ${node.func}
}
`;
        var finScript = null;
        var finOpt = null;
        node.topic = n.topic;
        node.outstandingTimers = [];
        node.outstandingIntervals = [];
        node.clearStatus = false;

        let context = {
            console:console,
            util:util,
            Buffer:Buffer,
            Date: Date,
            RED: {
                util: {... RED.util}
            },
            __node__: {
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
                send: function(send, id, msgs, cloneMsg) {
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
            // hack because vm2 hates global
            _global: {
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
                    context.clearTimeout(timerId);
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
            context.setTimeout[util.promisify.custom] = function(after, value) {
                return new Promise(function(resolve, reject) {
                    context.setTimeout(function(){ resolve(value); }, after);
                });
            };
            context.promisify = util.promisify;
        }
        try {
            const instanceVM = new vm.NodeVM({
                sandbox: context,
                wrapper: "none"
            });
            var iniScript = null;
            var iniOpt = null;
            if (node.ini) {
                var iniText = `
                    return (async function() {
                        const global = _global;
                        var node = {
                            id:__node__.id,
                            name:__node__.name,
                            log:__node__.log,
                            error:__node__.error,
                            warn:__node__.warn,
                            debug:__node__.debug,
                            trace:__node__.trace,
                            status:__node__.status,
                            send: function(msgs, cloneMsg) {
                                __node__.send(__send__, RED.util.generateId(), msgs, cloneMsg);
                            }
                        };
                        `+ node.ini +`
                    })();`;
                iniScript = new vm.VMScript(iniText);
            }
            
            node.script = new vm.VMScript(functionText);
            const functionProcess = instanceVM.run(node.script);

            if (node.fin) {
                var finText = "return (function () {\n"+
                "const global = _global;\n"+
                node.fin +
                "\n})();";
                finScript = new vm.VMScript(finText);
            }
            var promise = Promise.resolve();
            
            if (iniScript) {
                instanceVM.setGlobal('__send__', function(msgs) { node.send(msgs); });
                promise = instanceVM.run(iniScript);
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
                    if ((typeof err === "object") && err.hasOwnProperty("stack")) {
                        //remove unwanted part
                        var index = err.stack.search(/\n\s*at ContextifyScript.Script.runInContext/);
                        err.stack = err.stack.slice(0, index).split('\n').slice(0,-1).join('\n');
                        var stack = err.stack.split(/\r?\n/);

                        //store the error in msg to be used in flows
                        msg.error = err;

                        var line = 0;
                        var errorMessage;
                        if (stack.length > 0) {
                            while (line < stack.length && stack[line].indexOf("ReferenceError") !== 0) {
                                line++;
                            }

                            if (line < stack.length) {
                                errorMessage = stack[line];
                                var m = /:(\d+):(\d+)$/.exec(stack[line+1]);
                                if (m) {
                                    var lineno = Number(m[1])-16;
                                    var cha = m[2];
                                    errorMessage += " (line "+lineno+", col "+cha+")";
                                }
                            }
                        }
                        if (!errorMessage) {
                            errorMessage = err.toString();
                        }
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
                        instanceVM.run(finScript);
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
    RED.nodes.registerType("function_vm2",FunctionNode);
};
