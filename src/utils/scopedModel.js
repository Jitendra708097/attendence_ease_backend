function withOrg(where = {}, orgId) {
  return {
    ...where,
    org_id: orgId,
  };
}

function scopedModel(model, orgId) {
  return {
    findOne(options = {}) {
      return model.findOne({
        ...options,
        where: withOrg(options.where, orgId),
      });
    },
    findAll(options = {}) {
      return model.findAll({
        ...options,
        where: withOrg(options.where, orgId),
      });
    },
    findAndCountAll(options = {}) {
      return model.findAndCountAll({
        ...options,
        where: withOrg(options.where, orgId),
      });
    },
    create(data, options = {}) {
      return model.create(
        {
          ...data,
          org_id: orgId,
        },
        options
      );
    },
    update(values, options = {}) {
      return model.update(values, {
        ...options,
        where: withOrg(options.where, orgId),
      });
    },
    destroy(options = {}) {
      return model.destroy({
        ...options,
        where: withOrg(options.where, orgId),
      });
    },
  };
}

module.exports = {
  scopedModel,
};
