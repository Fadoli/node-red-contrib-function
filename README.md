# node-red-contrib-function

Provides alternative implementation of node-red nodes, aiming to provide either better security (vm2) or better performances (vm)

## Difference with NR implementation

1. the function inputed by the user is turned into a function, that gets called instead of re-executing the script with different variables.

1. some improvement in the `sandbox` to reduce overhead and security risk in `vm`

### function_unsafe

An implementation using the good ol' `eval`

* Speed : up to 3 times faster by reducing the workload in `vm` (specifically on short function)
* Security : None

### function_vm

An alternative implementation of the node-red function node.

* Speed : up to 2 to 3 times faster by reducing the workload in `vm` (specifically on short function)
* Security : a bit improved (see Security of the NR part)

### function_vm2

A more secure implementation using vm2.

* Speed : around 10x slower on short functions
* Security : heavily improved, they may be some issue in `vm2`, but it is MUCH stronger than `vm`

## NR function : a strange middleground between security and performance

### Speed

TLDR : it's possible to reach this implementation speed (x2-3) without loosing any 'security' feature of `vm`

It's also possible to fully embrace the speed and not run your code in `vm`

### Security

TLDR : a simple function node can compromise the whole instance

see point 2 in Difference with NR implementation.

it makes possible over-riding any function in RED.utils for the runtime :

``` JSON
[{"id":"470dca49.8c5bec","type":"function","z":"cfcd3c8c.f02bc8","name":"Hack NR","func":"","outputs":1,"noerr":0,"initialize":"return;\nconsole.log((this.constructor.constructor(\"return this\"))().global)\nthis.origclone = RED.util.cloneMessage;\nRED.util.cloneMessage = function (...params) {\n    console.log((this.constructor.constructor(\"return this\"))().global)\n    return origclone.call(this,...params);\n}","finalize":"RED.util.cloneMessage = this.origclone;","x":360,"y":140,"wires":[[]]}]
```

it adds a log to the cloneMessage function

## Todo

### Planned feature

Other alternative implementations using :

1. [isolated-vm](https://github.com/laverdet/isolated-vm)
1. Plain function (lowest security, highest performance) (already exists here : https://github.com/ozomer/node-red-contrib-unsafe-function)
1. Reusing Node-Red trads (pulling them with a script ?)