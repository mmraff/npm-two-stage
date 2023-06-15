# npm-two-stage
#### Code for dividing `npm install` into download and offline-install stages

This page is a placeholder.

If you are viewing this on the repository site, use the drop-down button at top to navigate to a branch named for a specific **npm** release to view full documentation and assets.

No assets are maintained on the master branch.
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

License: MIT

