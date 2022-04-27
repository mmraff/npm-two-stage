#!/usr/bin/bash
#nyc mocha ./test/0[12]*.js
#nyc --nycrc-path=./test/config/03_nycrc.json mocha ./test/03*.js
#nyc --nycrc-path=./test/config/04_nycrc.json mocha ./test/04*.js
#nyc --nycrc-path=./test/config/10_nycrc.json mocha ./test/10*.js
nyc --nycrc-path=./test/config/20_nycrc.json mocha ./test/20*.js
