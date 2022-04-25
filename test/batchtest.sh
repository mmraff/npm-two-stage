#!/usr/bin/bash
#nyc mocha ./test/0[12]*.js
#nyc --nycrc-path=./test/config/03_nycrc.json mocha ./test/03*.js
nyc --nycrc-path=./test/config/04_nycrc.json mocha ./test/04*.js
