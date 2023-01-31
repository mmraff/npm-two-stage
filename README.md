# npm-two-stage
#### Code for dividing `npm install` into download and offline-install stages

_________________________

## Who This Code Is For
Any node.js developer or configuration manager who has reason to install
node modules on a system that is not connected to the Internet. Some use cases:
- The security policy of an organization requires that the development/usage
 environment is disconnected from the Internet (some call this _Air-Gapped_)
- A student needs to work with node modules usually installable by npm, but
 there is no Internet connection available to the target system

## What This Is Not
This repository is not an entire fork of npm; it's only a set of new files and
modified versions of a few existing files. They are intended to be superimposed
on an existing npm installation.
_________________________

## Introduction
**npm** is a Javascript package manager and much more. You get it automatically
with a proper installation of the server-side JavaScript engine
**[node.js](http://nodejs.org/download/)**.  
[The official documentation of npm is here](https://docs.npmjs.com/).  
When used to install a package, the default behavior of npm is to fetch the
package and all of its dependencies from one or more remote servers, typically
the **[npm registry](https://docs.npmjs.com/misc/registry)**, and to install to
the current platform. This works fine for all users except, e.g., those in the
use cases above.  

Theoretically, one could manually install some kinds of packages and their trees
of dependencies by repeating this sequence however many times needed:
```sh
mkdir node_modules && cd node_modules
tar xzf path/to/module-name-version.tar.gz
mv package module-name && cd module-name
```
but for a non-trivial package heirarchy, not only would that be impractical,
it also would not work for every kind of package.  

With **npm-two-stage** installed over (say) a portable npm installation on a USB
drive, you simply have `npm download` collect the desired packages and all their
dependencies into a folder on the USB drive. Then you take the USB drive to the
target system which also has npm-two-stage installed, and run the offline install
command line (see below).  
_Note that your npm installations modified by npm-two-stage will behave exactly
the same as unmodified npm if you don't use the `--offline` option._
_________________________

## To Install/Uninstall; Usage
On the repo site, navigate to the branch with the name that exactly matches your installed version of npm, and refer to the instructions in the documentation there.

No assets are maintained on the master branch.
        
_________________________

License: MIT

