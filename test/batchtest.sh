#!/usr/bin/bash
#nyc mocha ./test/00[12]*.js
#nyc --nycrc-path=./test/config/003_nycrc.json mocha ./test/003*.js
## TODO: It may be that we can run test suites 4, 5, and 6 together ----------
#nyc --nycrc-path=./test/config/004_nycrc.json mocha ./test/004*.js
#nyc --nycrc-path=./test/config/005_nycrc.json mocha ./test/005*.js
#nyc --nycrc-path=./test/config/006_nycrc.json mocha ./test/006*.js
#nyc --nycrc-path=./test/config/010_nycrc.json mocha ./test/010*.js
nyc --nycrc-path=./test/config/020_nycrc.json mocha ./test/020*.js
