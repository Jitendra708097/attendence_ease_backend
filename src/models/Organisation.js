module.exports = (sequelize, DataTypes) => {
  const Organisation = sequelize.define(
    'Organisation',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      name: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      slug: {
        type: DataTypes.STRING,
        unique: true,
        allowNull: false,
      },
      plan: {
        type: DataTypes.ENUM('trial', 'standard', 'starter', 'growth', 'enterprise'),
        defaultValue: 'trial',
      },
      plan_definition_id: DataTypes.UUID,
      trial_ends_at: DataTypes.DATE,
      timezone: {
        type: DataTypes.STRING,
        defaultValue: 'Asia/Kolkata',
      },
      settings: {
        type: DataTypes.JSONB,
        defaultValue: {},
      },
      is_active: {
        type: DataTypes.BOOLEAN,
        defaultValue: true,
      },
      suspended_at: DataTypes.DATE,
      suspended_by: DataTypes.UUID,
      suspension_reason: DataTypes.TEXT,
      cancelled_at: DataTypes.DATE,
      cancelled_by: DataTypes.UUID,
      cancellation_reason: DataTypes.TEXT,
    },
    {
      tableName: 'organisations',
      timestamps: true,
      paranoid: true,
      underscored: true,
    }
  );

  Organisation.associate = (models) => {
    Organisation.hasMany(models.Branch, {
      foreignKey: 'org_id',
      as: 'branches',
    });
    Organisation.hasMany(models.Department, {
      foreignKey: 'org_id',
      as: 'departments',
    });
    Organisation.hasMany(models.Shift, {
      foreignKey: 'org_id',
      as: 'shifts',
    });
    Organisation.hasMany(models.Employee, {
      foreignKey: 'org_id',
      as: 'employees',
    });
    Organisation.hasMany(models.UserFeedback, {
      foreignKey: 'org_id',
      as: 'feedback',
    });
    Organisation.hasMany(models.Designation, {
      foreignKey: 'org_id',
      as: 'designations',
    });
    Organisation.belongsTo(models.PlanDefinition, {
      foreignKey: 'plan_definition_id',
      as: 'planDefinition',
    });
    Organisation.hasMany(models.PlanChangeHistory, {
      foreignKey: 'org_id',
      as: 'planChanges',
    });
  };

  return Organisation;
};
