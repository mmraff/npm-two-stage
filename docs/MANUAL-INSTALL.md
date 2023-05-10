# npm-two-stage
#### Code for dividing `npm install` into download and offline-install stages

## Manual Installation Instructions
These instructions are for the target platform that is not connected to
the Internet. You can install **node.js** (**npm** included) while
disconnected, so it stands to reason that you should also be able to
install **npm-two-stage** under the same conditions.

Before performing these steps, *please* verify that the **npm** version
named in this copy of **npm-two-stage** is exactly the same as the version
of your target **npm** installation.

You can check what branch you're looking at on **github**.

You can also look in the `package.json` of this project to see which
version of **npm** is listed in the `dependencies`.

Having done that, you're ready to proceed.

1. Look in the `src` directory of this project. These are the files that
  you will copy into the target `npm` location
  *(but don't put them there yet!)*.
  Note that the `download` and `offliner` subdirectories are not part
  of an untouched **npm** installation, so you will be able to copy those
  in without fear of overwriting anything.

2. Other than `download` and `offliner`, take an inventory of the files
  in the `src` directory.

3. Navigate to the `lib` subdirectory of your target `npm` root
  directory.

4. Take note of the files from the inventory that already exist there
  (for example, `install.js`).

5. For each **npm-two-stage** `src` file that already exists under
  `npm/lib/`, rename the npm file in your preferred backup name style
  (for example, you could add the suffix `.BAK`).

6. Now copy all the items from the project `src` directory into `npm/lib/`.

This completes **npm-two-stage** installation. There are no extra packages
to be installed.

To uninstall, you would delete the files you copied in, also delete the
`download` and `offliner` directories, then rename the backups to their
original names.
