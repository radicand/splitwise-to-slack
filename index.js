var async = require('async');
var _ = require('lodash');
var request = require('request');
var fs = require('fs');
var settings = require('./settings.json');

var j = request.jar();
var cookie = request.cookie('_splitwise_session=' + settings.splitwiseSession);
j.setCookie(cookie, 'https://secure.splitwise.com/');

var postToSlack = function(payload, done) {
    if (_.isArray(payload)) {
        return async.each(payload, postToSlack, done);
    }

    return request({
        method: 'post',
        url: settings.slack.webhookUrl,
        json: payload
    }, function(err, resp, body) {
        return done(err, body);
    });
};

return async.auto({
    expenses: function(next) {
        return request({
            url: 'https://secure.splitwise.com/api/v3.0/get_expenses',
            jar: j,
            json: true
        }, function(err, resp, body) {
            return next(err, body);
        });
    },
    currencies: function (next) {
        return request({
            url: 'https://secure.splitwise.com/api/v3.0/get_currencies',
            jar: j,
            json: true
        }, function(err, resp, body) {
            return next(err, body);
        });
    },
    group: function(next) {
        return request({
            url: 'https://secure.splitwise.com/api/v3.0/get_groups',
            jar: j,
            json: true
        }, function(err, resp, body) {
            return next(err, body);
        });
    },
    readState: function (next) {
        return fs.readFile(settings.stateFilePath, function (err, str) {
            if (err) {
                if (err.code === 'ENOENT') {
                    console.log('State file does not exist, will create it on completion');
                    return next();
                }
                return next(err);
            }

            try {
                return next(null, JSON.parse(str));
            } catch (e) {
                console.warn('Unable to parse state file, perhaps corrupted');
                return next(e);
            }
        });
    },
    formatPayload: ['expenses', 'group', 'currencies', 'readState', function(next, args) {
        var cMap = _.indexBy(args.currencies.currencies, 'currency_code');
        var stateMap = {};
        if (args.readState) {
            stateMap = _.indexBy(args.readState.expenses, 'id');
        }
        var out = _.chain(args.expenses.expenses)
            .filter(function (expense) {
                // do smarter checks here later, for now just check if ID exists in state to ignore it
                if (expense.deleted_at) return false;
                return !stateMap[expense.id];

                //return true;
            })
            .sortBy('created_at')
            .map(function(expense) {
                var currency = cMap[expense.currency_code].unit;
                var description, payload;
                if (expense.creation_method === 'payment') {
                    description = 'A payment of ' + currency + expense.cost + ' was recorded at ' + expense.date;
                    payload = {
                        channel: settings.slack.channel,
                        text: '*'+description+'*',
                        attachments: [{
                            fallback: description,
                            color: '#00D000',
                            fields: _.chain(expense.users)
                                .map(function (user) {
                                    return {
                                        title: user.user.first_name + ' ' + user.user.last_name,
                                        value: (parseFloat(user.paid_share) > 0.0) ?
                                            ('Paid ' + currency + user.paid_share) :
                                            ('Received ' + currency + user.owed_share),
                                        short: true
                                    };
                                })
                                .value()
                        }]
                    };

                } else {
                    var creator = expense.created_by.first_name + ' ' + expense.created_by
                        .last_name;
                    description = creator + ' added a ' + currency + expense.cost +
                        ' receipt for ' + expense.description + ' on ' + expense.date;
                    payload = {
                        channel: settings.slack.channel,
                        text: '*'+description+'*',
                        attachments: [{
                            fallback: description,
                            color: '#D00000',
                            fields: _.chain(expense.users)
                                .map(function (user) {
                                    return {
                                        title: user.user.first_name + ' ' + user.user.last_name,
                                        value: (parseFloat(user.paid_share) > 0.0) ?
                                            ('Paid ' + currency + user.paid_share +
                                                ' and is owed ' + currency + user.net_balance) :
                                            ('Owes ' + currency + user.owed_share),
                                        short: true
                                    };
                                })
                                .value()
                        }]
                    };

                    if (expense.details) {
                        payload.attachments.unshift({
                            fallback: 'Details',
                            color: '#00D000',
                            fields: _.map(expense.details.split('\n\r'), function (detail) {
                                return {
                                    title: 'Detail',
                                    value: detail,
                                    short: false
                                };
                            })
                        });
                    }
                }

                return payload;
            })
            .value();

        return next(null, out);
    }],
    saveState: ['expenses', 'formatPayload', function (next, args) {
        return fs.writeFile(settings.stateFilePath, JSON.stringify(args.expenses), function (err) {
            if (err) return next(err);

            return next();
        });
    }],
    sendToSlack: ['formatPayload', function(next, args) {
        //return next(null, args.formatPayload);
        return postToSlack(args.formatPayload, next);
    }]
}, function(err, data) {
    if (err) {
        console.warn('Error!', err, err.message);
        return;
    }

    console.log('payload sent: ' + JSON.stringify(data.formatPayload, null, 2));

    return;
});
