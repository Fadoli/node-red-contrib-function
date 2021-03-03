# node-red-contrib-function

Provides an alternative implementation of node-red functio node, aiming to provide more security and performance

benchmark information can be found in [bench.md](./bench.md)

## Difference with NR implementation

1. the function inputed by the user is turned into a function, that gets called instead of re-executing the script with different variables.

1. some improvement in the `sandbox` to reduce overhead and security risk in `vm`

## Speed

"Benchmark" runned on a non-modified Node-Red `v1.2.9` on w10

On the hardware site my I've got an AMD r5 5600x, with 32GB of 3200MHz cl 16-18-18 memory

the benchmark is runned by creating an endless loop in a very short flow with very short function. (it increase the impact of the overhead of the function)

<details>
<summary> here's the flow used </summary>

```JSON
[{"id":"84cc5ffb.d21618","type":"inject","z":"d7d8ed0f.6ee418","name":"","props":[{"p":"payload"},{"p":"topic","vt":"str"}],"repeat":"","crontab":"","once":false,"onceDelay":0.1,"topic":"","payload":"","payloadType":"date","x":160,"y":260,"wires":[["b8fec2a3.b96b6"]]},{"id":"3406b670.2976da","type":"function","z":"d7d8ed0f.6ee418","name":"random toto & titi","func":"msg.payload = {\n    toto: Math.random(),\n    titi: Math.random() + 1\n}\n\n\nreturn msg;","outputs":1,"noerr":0,"initialize":"","finalize":"","x":530,"y":260,"wires":[["b8fec2a3.b96b6"]]},{"id":"b8fec2a3.b96b6","type":"function","z":"d7d8ed0f.6ee418","name":"count msg/s","func":"this.count++;\n\nreturn msg;","outputs":1,"noerr":0,"initialize":"// Code added here will be run once\n// whenever the node is deployed.\nconst self = this;\n\nfunction resetCount () {\n    node.status({fill:\"green\",shape:\"dot\",text:\"\"+self.count});\n    self.count = 0;\n}\n\nthis.count = 0;\nthis.interval = setInterval(resetCount,1000);\n","finalize":"// Code added here will be run when the\n// node is being stopped or re-deployed.\n\nclearInterval(this.interval);","x":330,"y":260,"wires":[["3406b670.2976da"]]},{"id":"282535cd.a6cb9a","type":"comment","z":"d7d8ed0f.6ee418","name":"NR","info":"","x":130,"y":220,"wires":[]},{"id":"2572bc31.e6e4cc","type":"inject","z":"d7d8ed0f.6ee418","name":"","props":[{"p":"payload"},{"p":"topic","vt":"str"}],"repeat":"","crontab":"","once":false,"onceDelay":0.1,"topic":"","payload":"","payloadType":"date","x":160,"y":360,"wires":[["13ab069c.1a80d1"]]},{"id":"8e462ba.15474d8","type":"comment","z":"d7d8ed0f.6ee418","name":"Custom","info":"","x":130,"y":320,"wires":[]},{"id":"13ab069c.1a80d1","type":"function2","z":"d7d8ed0f.6ee418","name":"count msg/s","func":"this.count++;\n\nreturn msg;","outputs":1,"noerr":0,"initialize":"// Code added here will be run once\n// whenever the node is deployed.\nconst self = this;\n\nfunction resetCount () {\n    node.status({fill:\"green\",shape:\"dot\",text:\"\"+self.count});\n    self.count = 0;\n}\n\nthis.count = 0;\nthis.interval = setInterval(resetCount,1000);\n","finalize":"// Code added here will be run when the\n// node is being stopped or re-deployed.\n\nclearInterval(this.interval);","x":330,"y":360,"wires":[["7edc29e4.33a468"]]},{"id":"7edc29e4.33a468","type":"function2","z":"d7d8ed0f.6ee418","name":"random toto & titi","func":"msg.payload = {\n    toto: Math.random(),\n    titi: Math.random() + 1\n}\n\n\nreturn msg;","outputs":1,"noerr":0,"initialize":"","finalize":"","x":530,"y":360,"wires":[["13ab069c.1a80d1"]]}]
```

</details>

| Implementation | Maximum msg/s reached |
|:--------------:|:---------------------:|
|custom Function2| ~210.000 msg/s |
|Node-Red Function| ~41.000 msg/s |

Note : to obtain such result, several messages have to be inserted (more than one click on the inject node)

## Security

A simple function node can compromise the whole instance, it is possible to override any function in RED.utils in the whole runtime :

```JSON
[{"id":"470dca49.8c5bec","type":"function","z":"cfcd3c8c.f02bc8","name":"Hack NR","func":"","outputs":1,"noerr":0,"initialize":"this.origclone = RED.util.cloneMessage;\n\nRED.util.cloneMessage = function (...params) {\n    console.log(\"Wanting to clone\" + JSON.stringify(params))\n    return origclone.call(this,...params);\n}","finalize":"RED.util.cloneMessage = this.origclone;","x":360,"y":140,"wires":[[]]}]
```

This adds a log to the cloneMessage function.

Note, security holes from within `vm` are still accessible

```js
console.log((this.constructor.constructor("return this"))().global)
```

this leaks the global object (outside vm) inside the vm.
