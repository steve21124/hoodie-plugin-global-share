var async = require('async');
var _ = require('lodash');


module.exports = function (hoodie, callback) {

  // when a user doc is updated, check if we need to setup replication
  hoodie.account.on('user:change', exports.handleChange, exports.dbname, hoodie);

  // remove docs from global share db
  hoodie.task.on('globalshareunpublish:add', function (db, task) {
    async.forEachSeries(task.targets || [], function (target, cb) {
      hoodie.database(exports.dbname).remove(target.type, target.id, cb);
    },
    function (err) {
      if (err) {
        return hoodie.task.error(db, task,
          'Failed to remove all targets from global share db'
        );
      }
      hoodie.task.success(db, task);
    });
  });

  // initialize the plugin
  async.series([
    async.apply(exports.dbAdd, hoodie),
    async.apply(hoodie.database(exports.dbname).addPermission,
      'global-share-per-user-writes',
      exports.permission_check
    ),
    async.apply(exports.ensureCreatorFilter, exports.dbname, hoodie),
    async.apply(hoodie.database(exports.dbname).grantPublicWriteAccess),
    async.apply(exports.catchUp, exports.dbname, hoodie)
  ],
  callback);

};


exports.dbname = function () {
  return 'hoodie-plugin-global-share';
};

exports.dbAdd = function (hoodie, callback) {

  hoodie.database.add(exports.dbname, function (err) {

    if (err && err.error === 'file_exists') {
      return callback();
    }

    if (err) {
      return callback(err);
    }
  });

};


exports.permission_check = function (newDoc, oldDoc, userCtx) {

  function hasRole(x) {
    for (var i = 0; i < userCtx.roles.length; i++) {
      if (userCtx.roles[i] === x) {
        return true;
      }
    }
    return false;
  }

  if (hasRole('_admin')) {
    // let admins remove docs etc, otherwise the unpublish
    // task would fail
    return;
  }

  if (!userCtx.name) {
    throw {
      unauthorized: 'You must have an authenticated session'
    };
  }

  if (oldDoc) {

    if (newDoc._deleted) {
      // delete
      if (!hasRole(oldDoc.createdBy)) {
        throw {
          unauthorized: 'Only creator can delete this'
        };
      }

    } else {
      // edit
      if (!hasRole(oldDoc.createdBy)) {
        throw {
          unauthorized: 'Only creator can edit this'
        };
      }
    }
  } else {
    // create
    if (!hasRole(newDoc.createdBy)) {
      throw {
        unauthorized: 'createdBy must match your username'
      };
    }
  }
};


// adds a filter for public === true on user db so we can do
// filtered replication to global share db
exports.setupPublicFilter = function (user, hoodie, callback) {
  var dburl = '/' + encodeURIComponent(user.database);
  var filter_ddoc = {
    _id: '_design/filter_global-share-public-docs',
    filters: {
      publicDocs: (function (doc) {
        return !!(doc.$public);
      }()).toString()
    }
  };

  hoodie.request('POST', dburl, {
    data: filter_ddoc
  }, function (err) {
    if (err && err.error === 'conflict') {
      // filter already exists, ignore
      return callback();
    }
    return callback(err);
  });

};


// sets up replication from user db to global share db
exports.setupUserToPublic = function (user, dbname, hoodie, callback) {

  exports.setupPublicFilter(user, function (err) {

    if (err) {
      console.error('Error setting up publicDocs filter for user');
      console.error(user);
      return callback(err);
    }

    var doc = {
      source: user.database,
      target: dbname,
      filter: 'filter_global-share-public-docs/publicDocs',
      continuous: true,
      user_ctx: {
        name: user.name,
        roles: user.roles
      }
    };

    hoodie.request('POST', '/_replicator', {
      data: doc
    }, function (err, res) {
      if (err) {
        console.error(
          'Error setting up replication to public db ' +
          'for user'
        );
        console.error(user);
        return callback(err);
      }

      var url = '/_users/' + encodeURIComponent(user._id);

      hoodie.request('GET', url, {}, function (err, user) {
        if (err) {
          return callback(err);
        }
        // user doc may have been updated since last time
        user = _.extend(user, {
          globalShareReplicationOutgoing: res.id,
          globalShares: true
        });

        hoodie.request('PUT', url, {
          data: user
        }, function (err) {
            if (err) {
              console.error(
                'Error setting ' +
                'globalShareReplicationOutgoing ' +
                'property on user doc'
              );
              console.error(user);
              return callback(err);
            }
            console.log(
              'Setup userdb->public replication for ' +
              user.database
            );
            return callback();
          });
      });

    });

  });

};


// sets up replication from global share db to user db
exports.setupPublicToUser = function (user, dbname, hoodie, callback) {
  var doc = {
    source: dbname,
    target: user.database,
    filter: 'filter_global-share-creator/excludeCreator',
    query_params: {
      name: user.id
    },
    continuous: true,
    user_ctx: {
      name: user.name,
      roles: user.roles
    }
  };

  hoodie.request('POST', '/_replicator', {
    data: doc
  }, function (err, res) {
    if (err) {
      console.error('Error setting up replication from public to user share');
      console.error(user);
      console.error(doc);
      return callback(err);
    }

    var url = '/_users/' + encodeURIComponent(user._id);

    hoodie.request('GET', url, {}, function (err, user) {
      if (err) {
        return callback(err);
      }
      // user doc may have been updated since
      user = _.extend(user, {
        globalShareReplicationIncoming: res.id,
        globalShares: true
      });

      hoodie.request('PUT', url, {
        data: user
      }, function (err) {
        if (err) {
          console.error(
            'Error updating ' +
            'globalShareReplicationIncoming ' +
            'property on user doc'
          );
          console.error(user);
          return callback(err);
        }
        console.log(
          'Setup public->userdb replication for ' +
          user.database
        );
        return callback();
      });

    });

  });

};


// when a user doc changes, check if we need to setup replication for it
exports.handleChange = function (doc, dbname, hoodie, callback) {

  if (_.contains(doc.roles, 'confirmed') && doc.database) {

    if (!doc.globalShares) {

      async.series([
        async.apply(exports.setupUserToPublic, doc, dbname, hoodie),
        async.apply(exports.setupPublicToUser, doc, dbname, hoodie)
      ],
      function (err) {
        if (err) {
          console.error(err);
        }
        if (callback) {
          return callback(err);
        }
      });
    }
  }
};


// scan through all users in _users db and check if we need to
// setup replication for them - unfortunately, we can't add a design
// doc to the _users db to create a view for this!
exports.catchUp = function (dbname, hoodie, callback) {
  var url = '/_users/_all_docs';

  hoodie.request('GET', url, {}, function (err, body) {
    if (err) {
      return callback(err);
    }

    async.forEachSeries(body.rows, function (row, cb) {
      if (/_design/.test(row.id)) {
        // skip design docs
        return cb();
      }

      var docurl = '/_users/' + encodeURIComponent(row.id);

      hoodie.request('GET', docurl, {}, function (err, doc) {
        if (err) {
          return cb(err);
        }
        exports.handleChange(doc, dbname, hoodie, cb);
      });
    },
    callback);

  });

};


// add filter to public share db stop your own docs being
// replicated back from public share db - avoids conflicts
exports.ensureCreatorFilter = function (dbname, hoodie, callback) {
  var filter_ddoc = {
    _id: '_design/filter_global-share-creator',
    filters: {
      excludeCreator: (function (doc, req) {
        return function () {
          if (doc.createdBy !== req.name) {
            return true;
          } else {
            return false;
          }
        };
      }()).toString()
    }
  };

  hoodie.request('POST', dbname, {
    data: filter_ddoc
  }, function (err) {
    if (err && err.error === 'conflict') {
      // filter already exists, ignore
      return callback();
    }

    return callback(err);
  });

};

